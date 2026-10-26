/**
 * Retrieval eval over a small synthetic corpus.
 *
 *   offline  seed the fixtures into a throwaway database (dropped afterwards) and an in-memory index with the fake
 *            embedder, then ask the golden questions; needs only a reachable MongoDB
 *   live     ask the golden questions of the real store and index with the configured embedder, read-only; the
 *            fixtures must already be in the brain under the import identity `eval/<fixture id>` (see seedRequests)
 *
 * Eval searches never record recall history.
 */
import { randomBytes } from 'node:crypto';

import mongoose from 'mongoose';

import { type BrainConfig, loadBrainConfig } from '../brain/config.js';
import { type Embedder, createEmbedder, createFakeEmbedder } from '../brain/embeddings/index.js';
import { type BrainIndex, openBrainIndex } from '../brain/index/sqlite.js';
import { BrainEntry, type BrainKind } from '../brain/model.js';
import { identityOf } from '../brain/runtime.js';
import { type SearchDeps, searchBrain } from '../brain/search.js';
import { BrainStore } from '../brain/store.js';
import fixturesFile from './fixtures.json' with { type: 'json' };
import goldenFile from './golden.json' with { type: 'json' };
import { type EvalSummary, type GoldenQuestion, type QuestionOutcome, scoreQuestion, summarize } from './score.js';

export interface Fixture { slug: string; title: string; kind: BrainKind; body: string; tags: string[]; supersededBy?: string }
interface Golden { abstainThreshold: number; questions: GoldenQuestion[] }

export const FIXTURES = fixturesFile.notes as Fixture[];
export const GOLDEN = goldenFile as Golden;
export const EVAL_SOURCE = 'eval';
const TEMP_DB_PREFIX = 'badland-brain-eval-';

export interface EvalResult { mode: 'offline' | 'live'; summary: EvalSummary; outcomes: QuestionOutcome[] }

async function seedFixtures(store: BrainStore): Promise<Map<string, string>> {
  const actor = { agent: 'eval', originClass: 'agent' as const };
  const slugs = new Map<string, string>();
  for (const note of FIXTURES) {
    const { entry } = await store.note(actor, { title: note.title, body: note.body, kind: note.kind, tags: note.tags, source: { system: EVAL_SOURCE, externalId: note.slug } });
    slugs.set(note.slug, entry.slug);
  }
  for (const note of FIXTURES.filter((n) => n.supersededBy)) {
    const old = await store.get(slugs.get(note.slug) ?? '');
    const next = FIXTURES.find((n) => n.slug === note.supersededBy);
    if (old && next) {
      // The successor already exists with this body, so the supersede folds `old` into it and returns it.
      const replaced = await store.supersede(actor, old.slug, { body: next.body, reason: 'eval supersession', expectedHash: old.contentHash, title: next.title });
      slugs.set(next.slug, replaced.slug);
    }
  }
  return slugs;
}

/**
 * Live mode: the golden set names fixtures by id, so each id is resolved to the slug of the entry carrying that
 * fixture's import identity (`eval/<id>`) in the live store. Missing ids stop the run, instead of fixture ids being
 * scored as slug prefixes and every correct hit being reported as a miss.
 */
async function resolveFixtureSlugs(): Promise<Map<string, string>> {
  const slugs = new Map<string, string>();
  const missing: string[] = [];
  for (const note of FIXTURES) {
    const doc = await BrainEntry.findOne({ forgotten: { $exists: false }, 'source.system': EVAL_SOURCE, 'source.externalId': note.slug }).sort({ createdAt: -1 }).select('slug').lean();
    if (doc) {
      slugs.set(note.slug, doc.slug);
    } else {
      missing.push(note.slug);
    }
  }
  if (missing.length > 0) {
    throw new Error(`live eval: no entry carries the eval identity for ${missing.join(', ')}; run \`badland-brain eval --seed\` first`);
  }
  return slugs;
}

async function ask(deps: SearchDeps, slugMap: Map<string, string>): Promise<QuestionOutcome[]> {
  const remap = (prefixes: string[]): string[] => prefixes.map((p) => slugMap.get(p) ?? p);
  const outcomes: QuestionOutcome[] = [];
  for (const question of GOLDEN.questions) {
    const hits = await searchBrain(deps, 'eval', { query: question.question, kinds: question.kinds, topK: 5, includeSuperseded: false });
    outcomes.push(scoreQuestion({ ...question, expectSlugPrefixes: remap(question.expectSlugPrefixes), forbidSlugPrefixes: remap(question.forbidSlugPrefixes) }, hits, GOLDEN.abstainThreshold));
  }
  return outcomes;
}

/** Offline: a throwaway database on `mongoUri`'s server, dropped when the run ends, and an in-memory index. */
export async function runOfflineEval(mongoUri: string): Promise<EvalResult> {
  const dbName = `${TEMP_DB_PREFIX}${randomBytes(4).toString('hex')}`;
  const config = loadBrainConfig({ BRAIN_EMBED_PROVIDER: 'fake', BRAIN_EMBED_DIMS: '256', BRAIN_DATA_DIR: '/nonexistent' });
  const embedder = createFakeEmbedder(256);
  await mongoose.connect(mongoUri, { dbName, serverSelectionTimeoutMS: 10_000 });
  const index = openBrainIndex({ path: ':memory:', identity: identityOf(config, embedder) });
  try {
    await BrainEntry.init();
    const slugMap = await seedFixtures(new BrainStore({ index, embedder, config }));
    const outcomes = await ask({ index, embedder, config, recordRecall: false }, slugMap);
    return { mode: 'offline', summary: summarize(outcomes), outcomes };
  } finally {
    index.close();
    // Only ever the database this run created.
    if (mongoose.connection.db?.databaseName === dbName && dbName.startsWith(TEMP_DB_PREFIX)) {
      await mongoose.connection.dropDatabase();
    }
    await mongoose.disconnect();
  }
}

/** Live: the real store and index, read-only, with the configured embedder. */
export async function runLiveEval(options: { mongoUri: string; config: BrainConfig; env?: NodeJS.ProcessEnv; embedder?: Embedder; index?: BrainIndex }): Promise<EvalResult> {
  const embedder = options.embedder ?? createEmbedder(options.config, options.env);
  await mongoose.connect(options.mongoUri, { serverSelectionTimeoutMS: 10_000 });
  const index = options.index ?? openBrainIndex({ path: options.config.dbPath, identity: identityOf(options.config, embedder) });
  try {
    if (index.stale) {
      throw new Error('live eval: the index was built with another embedding identity; reindex first, or set the same BRAIN_EMBED_* settings as the server');
    }
    const slugMap = await resolveFixtureSlugs();
    const outcomes = await ask({ index, embedder, config: options.config, recordRecall: false }, slugMap);
    return { mode: 'live', summary: summarize(outcomes), outcomes };
  } finally {
    if (!options.index) {
      index.close();
    }
    await mongoose.disconnect();
  }
}

/**
 * The two bulk-import requests that seed a live brain with the fixtures under `eval/<id>`: every fixture first, then
 * each superseded fixture's identity again with its successor's body, which the store records as a supersession
 * folded into the successor. Re-sending them changes nothing. Retire them with `badland-brain forget-source eval`.
 */
export function seedRequests(): Array<{ originClass: 'agent'; items: Array<{ externalId: string; title: string; body: string; kind: BrainKind; tags: string[] }> }> {
  const all = FIXTURES.map((note) => ({ externalId: note.slug, title: note.title, body: note.body, kind: note.kind, tags: note.tags }));
  const revisions = FIXTURES.filter((note) => note.supersededBy).flatMap((note) => {
    const next = FIXTURES.find((n) => n.slug === note.supersededBy);
    return next ? [{ externalId: note.slug, title: next.title, body: next.body, kind: note.kind, tags: note.tags }] : [];
  });
  return [{ originClass: 'agent', items: all }, { originClass: 'agent', items: revisions }];
}
