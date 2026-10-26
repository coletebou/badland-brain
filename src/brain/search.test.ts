import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { testConfig, testIdentity } from '../test-support/brain.js';
import { clearTestDb, setupTestDb, teardownTestDb } from '../test-support/mongo.js';
import { createFakeEmbedder } from './embeddings/index.js';
import { openBrainIndex } from './index/sqlite.js';
import { type SearchDeps, importanceFactor, mmrSelect, recencyFactor, rrfFuse, searchBrain } from './search.js';
import { BrainInputError, BrainStore } from './store.js';

describe('search math', () => {
  it('rrf sums reciprocal ranks per leg and records ranks', () => {
    const fused = rrfFuse([[7, 3, 9], [3, 5]], 60);
    expect(fused.get(3)).toEqual({ score: 1 / 62 + 1 / 61, ranks: [2, 1] });
    expect(fused.get(5)).toEqual({ score: 1 / 62, ranks: [null, 2] });
    expect([...fused.entries()].sort((a, b) => b[1].score - a[1].score)[0][0]).toBe(3);
  });

  it('recency halves every half-life and floors at 0.05', () => {
    const day = 86_400_000;
    expect(recencyFactor(0, 30 * day, 30)).toBeCloseTo(0.5, 5);
    expect(recencyFactor(0, 0, 30)).toBe(1);
    expect(recencyFactor(0, 3000 * day, 30)).toBe(0.05);
  });

  it('importance maps 1..10 onto 0.7..1.3', () => {
    expect(importanceFactor(1)).toBeCloseTo(0.7);
    expect(importanceFactor(10)).toBeCloseTo(1.3);
    expect(importanceFactor(5.5)).toBeCloseTo(1.0);
  });

  it('mmr prefers diverse items', () => {
    const items = [{ id: 'a', e: 'x', r: 1 }, { id: 'b', e: 'x', r: 0.95 }, { id: 'c', e: 'y', r: 0.6 }];
    expect(mmrSelect(items, (t) => t.r, (p, q) => (p.e === q.e ? 1 : 0), 0.7, 2).map((t) => t.id)).toEqual(['a', 'c']);
    expect(mmrSelect(items, (t) => t.r, () => 0, 0.7, 5)).toHaveLength(3);
  });
});

describe('searchBrain', () => {
  const config = testConfig();
  const identity = testIdentity(config);
  const actor = { agent: 'codex@laptop', originClass: 'agent' as const };
  let deps: SearchDeps;
  let store: BrainStore;

  beforeAll(setupTestDb);
  afterAll(teardownTestDb);
  beforeEach(async () => {
    await clearTestDb();
    deps = { index: openBrainIndex({ path: ':memory:', identity }), embedder: createFakeEmbedder(32), config };
    store = new BrainStore(deps);
  });

  it('finds by keyword and by meaning, honours kinds, time, namespaces, and topK', async () => {
    await store.note(actor, { title: 'Ports', body: 'the preview server listens on 4310 behind the dev proxy', kind: 'reference', namespace: 'repo:example' });
    await store.note(actor, { title: 'Packages', body: 'Always use pnpm install in this repo.', kind: 'memory' });
    await store.note(actor, { title: 'Mail', body: 'the preview server listens on 4310', kind: 'mail' });

    const hits = await searchBrain(deps, 'test', { query: 'preview server listens on which port' });
    expect(hits[0].slug).toMatch(/^ports-/u);
    expect(hits.some((hit) => hit.kind === 'mail')).toBe(false);
    expect(hits[0].textRank).toBe(1);
    expect(hits[0].authorAgent).toBe('codex@laptop');
    expect(hits[0].score).toBeGreaterThan(0);
    expect(hits[0].score).toBeLessThanOrEqual(1.3);
    expect(hits[0].snippet).toContain('4310');

    const mail = await searchBrain(deps, 'test', { query: 'preview server 4310', kinds: ['mail'] });
    expect(mail.map((hit) => hit.kind)).toEqual(['mail']);
    expect(await searchBrain(deps, 'test', { query: 'pnpm', topK: 1 })).toHaveLength(1);
    await expect(searchBrain(deps, `ghp_${'k'.repeat(24)}`, { query: 'pnpm' })).rejects.toBeInstanceOf(BrainInputError);
    const failing = vi.spyOn(deps.embedder, 'embedQuery').mockRejectedValueOnce(new Error('quota exceeded'));
    const keywordOnly = await searchBrain(deps, 'test', { query: 'pnpm', topK: 1 });
    expect(keywordOnly).toHaveLength(1);
    expect(keywordOnly[0].vecRank).toBeNull();
    expect(keywordOnly[0].textRank).not.toBeNull();
    failing.mockRestore();
    expect(await searchBrain(deps, 'test', { query: 'pnpm', validAt: new Date(0) })).toHaveLength(0);
    expect((await searchBrain(deps, 'test', { query: 'preview server', namespaces: ['repo:example'] })).map((h) => h.namespace)).toEqual(['repo:example']);
    expect(await searchBrain(deps, 'test', { query: 'pnpm', namespaces: ['agent:nobody'] })).toEqual([]);
    expect(await searchBrain(deps, 'test', { query: 'pnpm', namespaces: [] })).toEqual([]);
  });

  it('ranks by meaning alone when the keyword leg has nothing to match', async () => {
    await store.note(actor, { title: 'Plans', body: 'where should we go when it is done', kind: 'memory' });
    // Every query word is an FTS stopword, so only the vector leg can find it.
    const hits = await searchBrain(deps, 'test', { query: 'where should we' });
    expect(hits).toHaveLength(1);
    expect(hits[0]).toMatchObject({ textRank: null, vecRank: 1 });
    expect(hits[0].similarity).toBeGreaterThan(0.3);
  });

  it('rejects a secret-shaped query before anything reaches the embedder', async () => {
    const embedQuery = vi.spyOn(deps.embedder, 'embedQuery');
    await expect(searchBrain(deps, 'test', { query: `find Bearer ${'t'.repeat(24)}` })).rejects.toThrow(/query contains a secret-shaped value/u);
    expect(embedQuery).not.toHaveBeenCalled();
  });

  it('can search without recording recall, for the eval', async () => {
    await store.note(actor, { title: 'Ports', body: 'the preview server listens on 4310', kind: 'reference' });
    expect(await searchBrain({ ...deps, recordRecall: false }, 'eval', { query: 'preview server 4310' })).toHaveLength(1);
    expect(deps.index.recallSince()).toEqual([]);
    await searchBrain(deps, 'test', { query: 'preview server 4310' });
    expect(deps.index.recallSince()).toHaveLength(1);
  });

  it('serves keyword-only results while the index is stale', async () => {
    await store.note(actor, { title: 'Ports', body: 'the preview server listens on 4310', kind: 'reference' });
    const path = join(mkdtempSync(join(tmpdir(), 'brain-stale-')), 'b.sqlite');
    const fresh = new BrainStore({ index: openBrainIndex({ path, identity }), embedder: createFakeEmbedder(32), config });
    await fresh.reindexAll();
    const stale = openBrainIndex({ path, identity: { ...identity, embedModel: 'other-model' } });
    expect(stale.stale).toBe(true);
    const hits = await searchBrain({ ...deps, index: stale }, 'test', { query: 'preview server 4310' });
    expect(hits).toHaveLength(1);
    expect(hits[0].vecRank).toBeNull();
    expect(hits[0].textRank).toBe(1);
    stale.close();
  });

  it('returns at most one chunk per entry by default', async () => {
    const long = Array.from({ length: 40 }, (_, i) => `## Section ${i}\n${'pnpm install detail '.repeat(40)}`).join('\n');
    await store.note(actor, { title: 'Long guide', body: long, kind: 'doc' });
    await store.note(actor, { title: 'Short', body: 'pnpm install is the rule', kind: 'memory' });
    const hits = await searchBrain(deps, 'test', { query: 'pnpm install', topK: 5 });
    expect(new Set(hits.map((hit) => hit.slug)).size).toBe(hits.length);
    expect(hits.length).toBe(2);
  });
});
