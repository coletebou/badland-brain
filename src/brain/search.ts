import { createHash } from 'node:crypto';

import { reasonOf } from '../log.js';
import { BRAIN_SCOPE_OF_KIND, type BrainConfig } from './config.js';
import type { Embedder } from './embeddings/index.js';
import { buildFtsQuery } from './index/fts-query.js';
import type { BrainIndex, IndexChunkRow, KnnHit, LegFilter } from './index/sqlite.js';
import type { BrainKind, BrainOriginClass, BrainTier } from './model.js';
import { rejectSecrets } from './store-views.js';

export interface SearchInput {
  query: string;
  /** Only these namespaces; absent means every namespace. */
  namespaces?: readonly string[];
  kinds?: BrainKind[];
  tier?: BrainTier;
  validAt?: Date;
  topK?: number;
  includeSuperseded?: boolean;
}

export interface SearchHit {
  slug: string;
  title: string;
  kind: BrainKind;
  tier: BrainTier;
  namespace: string;
  originClass: BrainOriginClass;
  authorAgent: string;
  importance: number;
  validFrom: string;
  updatedAt: string;
  startLine: number;
  endLine: number;
  snippet: string;
  score: number;
  /** Cosine similarity from the vector leg (1 - distance), null when only the keyword leg matched. */
  similarity: number | null;
  vecRank: number | null;
  textRank: number | null;
}

export interface SearchDeps {
  index: BrainIndex;
  embedder: Embedder;
  config: BrainConfig;
  now?: () => Date;
  /** Receives operational warnings (a failed vector leg); the server wires its logger, CLIs may leave it unset. */
  warn?: (message: string, meta?: Record<string, unknown>) => void;
  /** `false` keeps a run out of the recall history (the eval); searches record by default. */
  recordRecall?: boolean;
}

export const DEFAULT_KINDS: BrainKind[] = ['memory', 'decision', 'handoff', 'doc', 'reference'];

/** Weighted reciprocal rank fusion; ranks are 1-based per leg. */
export function rrfFuse(legs: number[][], k: number): Map<number, { score: number; ranks: Array<number | null> }> {
  const fused = new Map<number, { score: number; ranks: Array<number | null> }>();
  legs.forEach((leg, legIndex) => {
    leg.forEach((id, position) => {
      const rank = position + 1;
      const entry = fused.get(id) ?? { score: 0, ranks: legs.map(() => null) };
      entry.score += 1 / (k + rank);
      entry.ranks[legIndex] = rank;
      fused.set(id, entry);
    });
  });
  return fused;
}

/** Exponential decay with the given half-life in days, floored so old notes never vanish. */
export function recencyFactor(updatedAtMs: number, nowMs: number, halfLifeDays: number): number {
  const ageDays = Math.max(0, nowMs - updatedAtMs) / 86_400_000;
  return Math.max(0.05, 2 ** (-ageDays / halfLifeDays));
}

/** Importance 1..10 maps onto 0.7..1.3. */
export const importanceFactor = (importance: number): number => 0.7 + ((importance - 1) / 9) * 0.6;

/** Maximal marginal relevance: trade relevance against similarity to what is already picked. */
export function mmrSelect<T>(items: T[], relevance: (item: T) => number, similarity: (a: T, b: T) => number, lambda: number, k: number): T[] {
  const remaining = [...items];
  const picked: T[] = [];
  while (picked.length < k && remaining.length > 0) {
    let bestIndex = 0;
    let bestScore = -Infinity;
    remaining.forEach((candidate, i) => {
      const redundancy = picked.reduce((max, chosen) => Math.max(max, similarity(candidate, chosen)), 0);
      const score = lambda * relevance(candidate) - (1 - lambda) * redundancy;
      if (score > bestScore) {
        bestScore = score;
        bestIndex = i;
      }
    });
    picked.push(remaining.splice(bestIndex, 1)[0]);
  }
  return picked;
}

function snippetOf(text: string, query: string, maxChars: number): string {
  const tokens: string[] = query.toLowerCase().match(/[\p{L}\p{N}_.-]{2,}/gu) ?? [];
  const lower = text.toLowerCase();
  const first = tokens.map((token) => lower.indexOf(token)).filter((i) => i >= 0).sort((a, b) => a - b)[0] ?? 0;
  const start = Math.max(0, Math.min(first - Math.floor(maxChars / 4), Math.max(0, text.length - maxChars)));
  const slice = text.slice(start, start + maxChars).trim();
  return `${start > 0 ? '…' : ''}${slice}${start + maxChars < text.length ? '…' : ''}`;
}

const isKind = (value: string, kinds: BrainKind[]): value is BrainKind => (kinds as string[]).includes(value);

export async function searchBrain(deps: SearchDeps, agent: string, input: SearchInput): Promise<SearchHit[]> {
  // The agent name is the caller's key name and is persisted with each recall row.
  rejectSecrets('agent name', agent);
  // The query leaves the process for the embedding provider, so it passes the same gate as anything written.
  rejectSecrets('query', input.query);
  const { config, index } = deps;
  // The handle stays open for this search even if a reindex swaps the live index meanwhile.
  const release = index.retain();
  try {
    const topK = Math.min(Math.max(input.topK ?? config.defaultTopK, 1), config.maxTopK);
    const kinds = input.kinds && input.kinds.length > 0 ? input.kinds : DEFAULT_KINDS;
    const nowMs = (deps.now ?? (() => new Date()))().getTime();
    const filter: LegFilter = {
      scopes: [...new Set(kinds.map((kind) => BRAIN_SCOPE_OF_KIND[kind]))],
      kinds,
      tier: input.tier,
      namespaces: input.namespaces,
      validAtMs: input.validAt?.getTime(),
      includeSuperseded: input.includeSuperseded,
      nowMs,
    };
    const ftsQuery = buildFtsQuery(input.query);
    // A stale index holds vectors from another model or dimension: serve keyword-only until reindex. An embedding
    // failure gets the same treatment, since the keyword leg is local and stays useful meanwhile.
    const vectorLeg: Promise<KnnHit[]> = index.stale
      ? Promise.resolve([])
      : deps.embedder.embedQuery(deps.embedder.queryInput(input.query))
        .then((vector) => index.knn(vector, filter, config.candidatesPerLeg))
        .catch((error: unknown) => {
          deps.warn?.('brain vector leg unavailable; serving keyword results only', { reason: reasonOf(error) });
          return [];
        });
    const [vecHits, textHits] = await Promise.all([vectorLeg, Promise.resolve(ftsQuery ? index.fts(ftsQuery, filter, config.candidatesPerLeg) : [])]);
    const fused = rrfFuse([vecHits.map((hit) => hit.chunkId), textHits.map((hit) => hit.chunkId)], config.rrfK);
    const distances = new Map(vecHits.map((hit) => [hit.chunkId, hit.distance]));
    const rows = new Map(index.getChunks([...fused.keys()]).map((row) => [row.chunkId, row]));
    const maxScore = 2 / (config.rrfK + 1);

    const candidates = [...fused.entries()].flatMap(([chunkId, { score, ranks }]) => {
      const row = rows.get(chunkId);
      if (!row || !isKind(row.kind, kinds) || (input.namespaces && !input.namespaces.includes(row.namespace))) {
        return [];
      }
      const recency = row.tier === 'episodic' ? recencyFactor(row.updatedAtMs, nowMs, config.halfLifeDays) : 1;
      const adjusted = (score / maxScore) * recency * importanceFactor(row.importance);
      const distance = distances.get(chunkId);
      return [{ row, score: adjusted, similarity: distance === undefined ? null : Number((1 - distance).toFixed(4)), vecRank: ranks[0], textRank: ranks[1] }];
    }).sort((a, b) => b.score - a.score);

    // One chunk per entry: keep each entry's best-scoring chunk, then diversify across entries.
    const seenEntries = new Set<string>();
    const perEntry = candidates.filter((c) => {
      if (seenEntries.has(c.row.entryId)) {
        return false;
      }
      seenEntries.add(c.row.entryId);
      return true;
    });

    const similarity = (a: { row: IndexChunkRow }, b: { row: IndexChunkRow }): number =>
      a.row.entryId === b.row.entryId ? 1 : a.row.namespace === b.row.namespace ? 0.3 : 0;
    const picked = mmrSelect(perEntry, (c) => c.score, similarity, config.mmrLambda, topK);

    const queryHash = createHash('sha256').update(input.query.trim().toLowerCase()).digest('hex').slice(0, 16);
    if (deps.recordRecall !== false) {
      index.recordRecall(picked.map((c, i) => ({ queryHash, agent, chunkId: c.row.chunkId, entryId: c.row.entryId, rank: i + 1 })));
    }

    return picked.map(({ row, score, similarity, vecRank, textRank }) => ({
      slug: row.slug,
      title: row.title,
      kind: row.kind as BrainKind,
      tier: row.tier as BrainTier,
      namespace: row.namespace,
      originClass: row.originClass as BrainOriginClass,
      authorAgent: row.authorAgent,
      importance: row.importance,
      validFrom: new Date(row.validFromMs).toISOString(),
      updatedAt: new Date(row.updatedAtMs).toISOString(),
      startLine: row.startLine,
      endLine: row.endLine,
      snippet: snippetOf(row.text, input.query, config.snippetChars),
      score: Number(score.toFixed(4)),
      similarity,
      vecRank,
      textRank,
    }));
  } finally {
    release();
  }
}
