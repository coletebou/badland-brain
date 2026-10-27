import { chmodSync, mkdtempSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { type IndexEntryRow, openBrainIndex } from './sqlite.js';

const identity = { embedModel: 'fake', embedDims: 8, chunkTokens: 600, chunkOverlap: 72, ftsTokenizer: "unicode61 remove_diacritics 2 tokenchars '_-'" };
const vec = (...values: number[]): Float32Array => Float32Array.from(values);
const row = (over: Partial<IndexEntryRow> = {}): IndexEntryRow => ({
  entryId: 'e1', slug: 'pnpm', title: 'Use pnpm', tags: 'repo:example tooling', kind: 'memory', scope: 'core',
  tier: 'episodic', namespace: 'repo:example', originClass: 'agent', authorAgent: 'codex@laptop', importance: 5, validFromMs: 1000, invalidAtMs: null, updatedAtMs: 2000,
  ...over,
});
const tempDb = (): string => join(mkdtempSync(join(tmpdir(), 'brain-')), 'b.sqlite');

describe('index file permissions', () => {
  it.skipIf(process.platform === 'win32')('creates the index and its directory for the owner alone, and tightens an existing file', () => {
    const dir = join(mkdtempSync(join(tmpdir(), 'brain-perm-')), 'data');
    const path = join(dir, 'brain.sqlite');
    const index = openBrainIndex({ path, identity });
    index.upsertEntry({ entryId: 'e1', slug: 's', title: 't', tags: '', kind: 'memory', scope: 'core', tier: 'episodic', namespace: 'shared', originClass: 'agent', authorAgent: 'a', importance: 5, validFromMs: 0, invalidAtMs: null, updatedAtMs: 1 }, []);
    expect(statSync(dir).mode & 0o777).toBe(0o700);
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(statSync(`${path}-wal`).mode & 0o777).toBe(0o600);
    index.close();
    chmodSync(path, 0o644);
    openBrainIndex({ path, identity }).close();
    expect(statSync(path).mode & 0o777).toBe(0o600);
  });
});

describe('BrainIndex', () => {
  afterEach(() => vi.restoreAllMocks());

  it('names the Node floor when node:sqlite is missing instead of failing at import', () => {
    vi.spyOn(process, 'getBuiltinModule').mockReturnValue(undefined as never);
    expect(() => openBrainIndex({ path: ':memory:', identity })).toThrow(/Node 22\.13/u);
  });

  it('drops only the SQLite experimental warning while it loads the module', () => {
    const emitted: string[] = [];
    const original = process.emitWarning;
    const spy = vi.spyOn(process, 'getBuiltinModule').mockImplementation(((id: string) => {
      process.emitWarning('SQLite is an experimental feature and might change at any time', 'ExperimentalWarning');
      process.emitWarning('something else entirely');
      spy.mockRestore();
      return process.getBuiltinModule(id as 'node:sqlite');
    }) as never);
    process.emitWarning = ((warning: string | Error) => { emitted.push(String(warning)); }) as typeof process.emitWarning;
    try {
      openBrainIndex({ path: ':memory:', identity }).close();
    } finally {
      process.emitWarning = original;
    }
    expect(emitted).toEqual(['something else entirely']);
  });

  it('creates the schema, records identity, upserts, and searches both legs', () => {
    const index = openBrainIndex({ path: tempDb(), identity });
    expect(index.stale).toBe(false);
    index.upsertEntry(row(), [{ ord: 0, startLine: 1, endLine: 3, text: 'Always use pnpm install, never npm.', embedding: vec(1, 0, 0, 0, 0, 0, 0, 0) }]);
    index.upsertEntry(row({ entryId: 'e2', slug: 'ports', title: 'Ports', tags: '' }), [{ ord: 0, startLine: 1, endLine: 1, text: 'deploy-bot uses port 4310', embedding: vec(0, 1, 0, 0, 0, 0, 0, 0) }]);
    const filter = { scopes: ['core'] };
    const nearest = index.knn(vec(0.9, 0.1, 0, 0, 0, 0, 0, 0), filter, 5);
    expect(nearest).toHaveLength(2);
    expect(index.getChunks([nearest[0].chunkId])[0].slug).toBe('pnpm');
    expect(index.fts('"deploy-bot"', filter, 5).map((hit) => index.getChunks([hit.chunkId])[0].slug)).toEqual(['ports']);
    expect(index.fts('"pnpm"', filter, 5)).toHaveLength(1);
    expect(index.fts('"Ports"', filter, 5)).toHaveLength(1); // title column is indexed too
    expect(index.counts()).toEqual({ entries: 2, chunks: 2 });
    index.close();
  });

  it('replaces chunks on re-upsert, removes on delete, filters by scope, kind, tier, and time', () => {
    const index = openBrainIndex({ path: ':memory:', identity });
    index.upsertEntry(row(), [
      { ord: 0, startLine: 1, endLine: 1, text: 'one', embedding: vec(1, 0, 0, 0, 0, 0, 0, 0) },
      { ord: 1, startLine: 2, endLine: 2, text: 'two', embedding: vec(0, 1, 0, 0, 0, 0, 0, 0) },
    ]);
    index.upsertEntry(row(), [{ ord: 0, startLine: 1, endLine: 1, text: 'only', embedding: vec(1, 0, 0, 0, 0, 0, 0, 0) }]);
    expect(index.counts().chunks).toBe(1);
    expect(index.fts('"two"', { scopes: ['core'] }, 5)).toHaveLength(0);

    index.upsertEntry(row({ entryId: 'e3', slug: 'mail', kind: 'mail', scope: 'comms' }), [{ ord: 0, startLine: 1, endLine: 1, text: 'only', embedding: vec(1, 0, 0, 0, 0, 0, 0, 0) }]);
    expect(index.fts('"only"', { scopes: ['core'] }, 5)).toHaveLength(1);
    expect(index.fts('"only"', { scopes: ['core', 'comms'] }, 5)).toHaveLength(2);
    expect(index.knn(vec(1, 0, 0, 0, 0, 0, 0, 0), { scopes: ['core', 'comms'] }, 5)).toHaveLength(2);
    expect(index.fts('"only"', { scopes: ['core'], tier: 'curated' }, 5)).toHaveLength(0);
    expect(index.fts('"only"', { scopes: ['core', 'comms'], kinds: ['mail'] }, 5)).toHaveLength(1);
    expect(index.knn(vec(1, 0, 0, 0, 0, 0, 0, 0), { scopes: ['core', 'comms'], kinds: ['memory'] }, 5)).toHaveLength(1);
    expect(index.hasEntry('e1')).toBe(true);
    expect(index.hasEntry('nope')).toBe(false);

    index.upsertEntry(row({ entryId: 'e4', slug: 'old', invalidAtMs: 1500 }), [{ ord: 0, startLine: 1, endLine: 1, text: 'only', embedding: null }]);
    expect(index.fts('"only"', { scopes: ['core'] }, 5)).toHaveLength(1);
    expect(index.fts('"only"', { scopes: ['core'], includeSuperseded: true }, 5)).toHaveLength(2);
    expect(index.fts('"only"', { scopes: ['core'], validAtMs: 1200 }, 5)).toHaveLength(2);
    expect(index.fts('"only"', { scopes: ['core'], validAtMs: 1600 }, 5)).toHaveLength(1);
    expect(index.fts('"only"', { scopes: ['core'], validAtMs: 500 }, 5)).toHaveLength(0);

    index.removeEntry('e1');
    expect(index.counts()).toEqual({ entries: 2, chunks: 2 });
    expect(index.fts('"only"', { scopes: ['core'], includeSuperseded: true }, 5)).toHaveLength(1);

    index.cachePut('k', vec(1, 2, 3, 4, 5, 6, 7, 8));
    expect(Array.from(index.cacheGet('k') ?? [])).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    expect(index.cacheGet('missing')).toBeNull();
    index.recordRecall([{ queryHash: 'q', agent: 'a', chunkId: 1, entryId: 'e3', rank: 1 }]);
    index.close();
  });

  it('filters both legs by namespace, inside the vector table, and an empty namespace list matches nothing', () => {
    const index = openBrainIndex({ path: ':memory:', identity });
    const q = vec(1, 0, 0, 0, 0, 0, 0, 0);
    // The nearest vectors all sit in another namespace: a filter applied only after vec0's top-k would come back empty.
    for (let i = 0; i < 300; i++) {
      index.upsertEntry(row({ entryId: `b${i}`, slug: `b${i}`, namespace: 'agent:beta' }), [{ ord: 0, startLine: 1, endLine: 1, text: 'beta note', embedding: q }]);
    }
    index.upsertEntry(row({ entryId: 'a1', slug: 'a1', namespace: 'agent:alpha' }), [{ ord: 0, startLine: 1, endLine: 1, text: 'alpha note', embedding: vec(0.2, 0.9, 0, 0, 0, 0, 0, 0) }]);
    index.upsertEntry(row({ entryId: 's1', slug: 's1', namespace: 'shared' }), [{ ord: 0, startLine: 1, endLine: 1, text: 'shared note', embedding: vec(0.1, 0, 0.9, 0, 0, 0, 0, 0) }]);
    const slugs = (hits: Array<{ chunkId: number }>): string[] => index.getChunks(hits.map((h) => h.chunkId)).map((c) => c.slug).sort();
    expect(slugs(index.knn(q, { scopes: ['core'], namespaces: ['agent:alpha'] }, 2))).toEqual(['a1']);
    expect(slugs(index.knn(q, { scopes: ['core'], namespaces: ['agent:alpha', 'shared'] }, 2))).toEqual(['a1', 's1']);
    expect(index.knn(q, { scopes: ['core'], namespaces: [] }, 2)).toEqual([]);
    expect(slugs(index.fts('"note"', { scopes: ['core'], namespaces: ['shared'] }, 50))).toEqual(['s1']);
    expect(index.fts('"note"', { scopes: ['core'], namespaces: [] }, 50)).toEqual([]);
    expect(index.fts('"note"', { scopes: ['core'] }, 500)).toHaveLength(302);
    index.close();
  });

  it('keeps an entry current until its invalidation instant passes', () => {
    const index = openBrainIndex({ path: ':memory:', identity });
    const soon = Date.now() + 60_000;
    index.upsertEntry(row({ entryId: 'ending', slug: 'ending', invalidAtMs: soon }), [{ ord: 0, startLine: 1, endLine: 1, text: 'ending later', embedding: null }]);
    index.upsertEntry(row({ entryId: 'ended', slug: 'ended', invalidAtMs: 1500 }), [{ ord: 0, startLine: 1, endLine: 1, text: 'ended already', embedding: null }]);
    const slugs = (query: string, filter: object): string[] => index.fts(query, { scopes: ['core'], ...filter }, 5).map((hit) => index.getChunks([hit.chunkId])[0].slug);
    expect(slugs('"ending"', {})).toEqual(['ending']);
    expect(slugs('"ended"', {})).toEqual([]);
    expect(slugs('"ending"', { validAtMs: soon + 1 })).toEqual([]);
    expect(slugs('"ended"', { includeSuperseded: true })).toEqual(['ended']);
    index.close();
  });

  it('ignores an upsert that is older than the row already indexed', () => {
    const index = openBrainIndex({ path: ':memory:', identity });
    index.upsertEntry(row({ updatedAtMs: 3000 }), [{ ord: 0, startLine: 1, endLine: 1, text: 'newer snapshot', embedding: null }]);
    index.upsertEntry(row({ updatedAtMs: 2000 }), [{ ord: 0, startLine: 1, endLine: 1, text: 'older snapshot', embedding: null }]);
    expect(index.updatedAtOf('e1')).toBe(3000);
    expect(index.fts('"newer"', { scopes: ['core'] }, 5)).toHaveLength(1);
    expect(index.fts('"older"', { scopes: ['core'] }, 5)).toHaveLength(0);
    index.upsertEntry(row({ updatedAtMs: 3000 }), [{ ord: 0, startLine: 1, endLine: 1, text: 'same instant wins', embedding: null }]);
    expect(index.fts('"instant"', { scopes: ['core'] }, 5)).toHaveLength(1);
    index.close();
  });

  it('widens the vector fetch until enough rows survive the metadata filter', () => {
    const index = openBrainIndex({ path: ':memory:', identity });
    const q = vec(1, 0, 0, 0, 0, 0, 0, 0);
    for (let i = 0; i < 200; i++) {
      index.upsertEntry(row({ entryId: `c${i}`, slug: `c${i}`, tier: 'curated' }), [{ ord: 0, startLine: 1, endLine: 1, text: 'filler', embedding: q }]);
    }
    index.upsertEntry(row({ entryId: 'target', slug: 'target' }), [{ ord: 0, startLine: 1, endLine: 1, text: 'target', embedding: vec(0.9, 0.1, 0, 0, 0, 0, 0, 0) }]);
    const hits = index.knn(q, { scopes: ['core'], tier: 'episodic' }, 5);
    expect(hits).toHaveLength(1);
    expect(index.getChunks([hits[0].chunkId])[0].slug).toBe('target');
    index.close();
  });

  it('never asks vec0 for more than its k cap when a filter rejects the nearest thousands', () => {
    const index = openBrainIndex({ path: ':memory:', identity });
    const q = vec(1, 0, 0, 0, 0, 0, 0, 0);
    // >2560 episodic vectors in one partition: a widen sequence 160,640,2560,10240 would ask vec0 for 10240 (> its 4096 cap) and throw.
    for (let i = 0; i < 2600; i++) {
      index.upsertEntry(row({ entryId: `f${i}`, slug: `f${i}`, tier: 'episodic' }), [{ ord: 0, startLine: 1, endLine: 1, text: 'filler', embedding: q }]);
    }
    index.upsertEntry(row({ entryId: 'wanted', slug: 'wanted', tier: 'curated' }), [{ ord: 0, startLine: 1, endLine: 1, text: 'wanted', embedding: vec(0.95, 0.05, 0, 0, 0, 0, 0, 0) }]);
    const hits = index.knn(q, { scopes: ['core'], tier: 'curated', nowMs: 5000 }, 80);
    expect(index.getChunks(hits.map((h) => h.chunkId)).some((c) => c.slug === 'wanted')).toBe(true);
    index.close();
  });

  it('indexes a sentence-final identifier as its own token (no glued trailing period)', () => {
    const index = openBrainIndex({ path: ':memory:', identity });
    index.upsertEntry(row(), [{ ord: 0, startLine: 1, endLine: 1, text: 'the preview server listens on 4310.', embedding: null }]);
    expect(index.fts('4310', { scopes: ['core'] }, 5)).toHaveLength(1);
    index.close();
  });

  it('keeps recall rows when an entry leaves, and carries them into another index re-pointed at its chunks', () => {
    const prevPath = tempDb();
    const prev = openBrainIndex({ path: prevPath, identity });
    prev.upsertEntry(row(), [{ ord: 0, startLine: 1, endLine: 1, text: 'a fact', embedding: null }]);
    const chunkId = prev.fts('fact', { scopes: ['core'] }, 5)[0].chunkId;
    prev.recordRecall([{ queryHash: 'q1', agent: 'codex@laptop', chunkId, entryId: 'e1', rank: 1 }]);
    prev.upsertEntry(row({ entryId: 'gone', slug: 'gone' }), [{ ord: 0, startLine: 1, endLine: 1, text: 'gone body', embedding: null }]);
    prev.recordRecall([{ queryHash: 'q2', agent: 'codex@laptop', chunkId: prev.fts('gone', { scopes: ['core'] }, 5)[0].chunkId, entryId: 'gone', rank: 1 }]);
    prev.removeEntry('gone'); // a forget: the entry's rows go, its recall stays
    expect(prev.recallSince()).toHaveLength(2);
    prev.close();

    const live = openBrainIndex({ path: ':memory:', identity });
    live.upsertEntry(row({ slug: 'kept' }), [{ ord: 0, startLine: 1, endLine: 1, text: 'kept body', embedding: null }]);
    live.adoptRecallFrom(prevPath, 0);
    const carried = live.recallSince();
    expect(carried.map((r) => [r.queryHash, r.entryId])).toEqual([['q1', 'e1'], ['q2', 'gone']]);
    expect(live.getChunks([carried[0].chunkId]).map((c) => c.entryId)).toEqual(['e1']);
    expect(carried[1].chunkId).toBe(0); // no rebuilt chunk to point at
    live.adoptRecallFrom(prevPath, 0);
    expect(live.recallSince()).toHaveLength(2); // idempotent
    live.close();
  });

  it('marks the index stale when the identity changes', () => {
    const path = tempDb();
    openBrainIndex({ path, identity }).close();
    const same = openBrainIndex({ path, identity });
    expect(same.stale).toBe(false);
    same.close();
    const reopened = openBrainIndex({ path, identity: { ...identity, embedDims: 16 } });
    expect(reopened.stale).toBe(true);
    reopened.close();
  });
});
