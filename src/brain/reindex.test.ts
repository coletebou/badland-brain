import { copyFileSync, existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { testConfig } from '../test-support/brain.js';
import { clearTestDb, setupTestDb, teardownTestDb } from '../test-support/mongo.js';
import { createFakeEmbedder } from './embeddings/index.js';
import { moveIndexFiles, recoverInterruptedSwap } from './index/files.js';
import { openBrainIndex } from './index/sqlite.js';
import { BrainEntry } from './model.js';
import { getReindexStatus, resetReindexForTests, resumeCatchUp, startReindex, waitForReindex } from './reindex.js';
import { type BrainRuntime, createBrainRuntime, identityOf } from './runtime.js';
import { searchBrain } from './search.js';
import { BrainStore } from './store.js';

const actor = { agent: 'codex@laptop', originClass: 'agent' as const };

function makeRuntime(): { runtime: BrainRuntime; dbPath: string } {
  const dbPath = join(mkdtempSync(join(tmpdir(), 'brain-reindex-')), 'brain.sqlite');
  const config = testConfig({ BRAIN_DB_PATH: dbPath });
  const embedder = createFakeEmbedder(32);
  const index = openBrainIndex({ path: dbPath, identity: identityOf(config, embedder) });
  return { runtime: { config, index, embedder, store: new BrainStore({ index, embedder, config }), stale: index.stale }, dbPath };
}

describe('in-process reindex', () => {
  beforeAll(setupTestDb);
  afterAll(teardownTestDb);
  beforeEach(clearTestDb);
  afterEach(resetReindexForTests);

  it('rebuilds into a sibling file, swaps the live handle, and catches up late writes', async () => {
    const { runtime, dbPath } = makeRuntime();
    await runtime.store.note(actor, { title: 'Ports', body: 'the preview server listens on 4310', kind: 'reference' });
    await runtime.store.note(actor, { title: 'Pkg', body: 'always bun install', kind: 'memory' });
    // Searches leave recall rows; the rebuild must carry them over with chunk ids re-pointed at the rebuilt chunks.
    await searchBrain(runtime, 'test', { query: 'bun install' });
    await searchBrain(runtime, 'test', { query: 'preview server port' });
    const recallBefore = runtime.index.recallSince();
    expect(recallBefore.length).toBeGreaterThan(1);
    // Simulate a drifted index: drop one entry from SQLite so only a rebuild restores it.
    const doc = await BrainEntry.findOne({ title: 'Pkg' });
    runtime.index.removeEntry(doc!._id.toString());
    expect(runtime.index.counts().entries).toBe(1);

    const storeBefore = runtime.store;
    const embed = vi.spyOn(runtime.embedder, 'embedDocuments');
    const started = startReindex(runtime);
    expect(started.state).toBe('running');
    const status = await waitForReindex();
    expect(status).toMatchObject({ state: 'done', entries: 2, chunks: 2, error: null });
    expect(runtime.index.counts().entries).toBe(2);
    const recallAfter = runtime.index.recallSince();
    const history = (rows: typeof recallBefore) => rows.map((r) => [r.queryHash, r.agent, r.entryId, r.rank, r.atMs]);
    expect(history(recallAfter)).toEqual(history(recallBefore));
    // Rows whose chunk still existed in the old file point at the rebuilt chunk of the same entry; the entry
    // dropped from the old index above has no old ordinal to follow, so its rows keep the entry with chunk id 0.
    for (const row of recallAfter) {
      if (row.entryId === doc!._id.toString()) {
        expect(row.chunkId).toBe(0);
        continue;
      }
      expect(runtime.index.getChunks([row.chunkId]).map((c) => c.entryId)).toEqual([row.entryId]);
    }
    // The rebuild reused the live file's embedding cache, and callers holding the store now write to the new index.
    expect(embed).not.toHaveBeenCalled();
    expect(runtime.store).toBe(storeBefore);
    expect(existsSync(`${dbPath}.rebuild`)).toBe(false);
    expect(existsSync(`${dbPath}.previous`)).toBe(false);
    expect(existsSync(dbPath)).toBe(true);

    const hits = await searchBrain(runtime, 'test', { query: 'bun install' });
    expect(hits[0].title).toBe('Pkg');
    // The swapped store keeps working for new writes.
    await runtime.store.note(actor, { title: 'After', body: 'written after the swap', kind: 'memory' });
    expect(runtime.index.counts().entries).toBe(3);
    runtime.index.close();
  });

  it('keeps the retired handle open until every in-flight request has released it', async () => {
    const { runtime, dbPath } = makeRuntime();
    await runtime.store.note(actor, { title: 'Ports', body: 'the preview server listens on 4310', kind: 'reference' });
    const old = runtime.index;
    let finishEmbedding!: () => void;
    const gate = new Promise<void>((resolve) => { finishEmbedding = resolve; });
    const realEmbedQuery = runtime.embedder.embedQuery.bind(runtime.embedder);
    vi.spyOn(runtime.embedder, 'embedQuery').mockImplementationOnce(async (text) => { await gate; return realEmbedQuery(text); });
    const warn = vi.fn();
    const inFlight = searchBrain({ ...runtime, warn }, 'test', { query: 'preview server 4310' });
    startReindex(runtime);
    expect((await waitForReindex()).state).toBe('done');
    expect(runtime.index).not.toBe(old);
    expect(existsSync(`${dbPath}.previous`)).toBe(true); // still held for the request in flight
    const recallBeforeRelease = runtime.index.recallSince().length;
    finishEmbedding();
    const hits = await inFlight;
    expect(hits).toHaveLength(1);
    expect(hits[0].vecRank).not.toBeNull();
    expect(warn).not.toHaveBeenCalled();
    expect(() => old.counts()).toThrow();
    expect(existsSync(`${dbPath}.previous`)).toBe(false);
    // The recall row the retained search appended to the old file was carried into the live index when the handle retired.
    expect(runtime.index.recallSince().length).toBe(recallBeforeRelease + 1);
    runtime.index.close();
  });

  it('keeps the new index crash-safe across the swap, even when the retired handle closes after it', async () => {
    const { runtime, dbPath } = makeRuntime();
    await runtime.store.note(actor, { title: 'Ports', body: 'the preview server listens on 4310', kind: 'reference' });
    // A search holds the old handle across the swap, so it closes only once the new index has its own -wal and -shm.
    let finishEmbedding!: () => void;
    const gate = new Promise<void>((resolve) => { finishEmbedding = resolve; });
    const realEmbedQuery = runtime.embedder.embedQuery.bind(runtime.embedder);
    vi.spyOn(runtime.embedder, 'embedQuery').mockImplementationOnce(async (text) => { await gate; return realEmbedQuery(text); });
    const inFlight = searchBrain(runtime, 'test', { query: 'preview server 4310' });
    startReindex(runtime);
    expect((await waitForReindex()).state).toBe('done');
    await runtime.store.note(actor, { title: 'After', body: 'written after the swap', kind: 'memory' });
    finishEmbedding();
    await inFlight; // the retired handle closes here
    await runtime.store.note(actor, { title: 'Later', body: 'written after the old handle closed', kind: 'memory' });
    expect(existsSync(`${dbPath}-wal`)).toBe(true);
    // A crash now: copy the files as they are on disk, without closing the live handle, and open the copy.
    const copy = join(mkdtempSync(join(tmpdir(), 'brain-crash-')), 'brain.sqlite');
    for (const suffix of ['', '-wal', '-shm']) {
      if (existsSync(`${dbPath}${suffix}`)) {
        copyFileSync(`${dbPath}${suffix}`, `${copy}${suffix}`);
      }
    }
    const recovered = openBrainIndex({ path: copy, identity: identityOf(runtime.config, runtime.embedder) });
    expect(recovered.counts().entries).toBe(3);
    expect(recovered.fts('"swap" OR "closed"', { scopes: ['core'] }, 5)).toHaveLength(2);
    recovered.close();
    runtime.index.close();
  });

  it('removes entries forgotten mid-rebuild at once, and a restart replays a catch-up the swap left unfinished', async () => {
    const { runtime } = makeRuntime();
    const ports = await runtime.store.note(actor, { title: 'Ports', body: 'the preview server listens on 4310', kind: 'reference' });
    const withdrawn = await runtime.store.note(actor, { title: 'Withdrawn', body: 'a fact that gets withdrawn', kind: 'memory' });
    const realReindexAll = BrainStore.prototype.reindexAll;
    vi.spyOn(BrainStore.prototype, 'reindexAll').mockImplementationOnce(async function (this: BrainStore, ...args: Parameters<BrainStore['reindexAll']>) {
      const counts = await realReindexAll.apply(this, args);
      // Written while the rebuild ran, after its cursor had passed both entries: only the old file has these.
      await runtime.store.supersede(actor, ports.entry.slug, { body: 'the preview server listens on 4320', reason: 'moved', expectedHash: ports.entry.contentHash });
      await runtime.store.forget(actor, { slug: withdrawn.entry.slug }, 'withdrawn');
      // The process stops between the swap and the catch-up.
      vi.spyOn(runtime.store, 'indexEntry').mockRejectedValueOnce(new Error('process stopped'));
      return counts;
    });
    startReindex(runtime);
    expect(await waitForReindex()).toMatchObject({ state: 'failed', error: 'process stopped' });
    const withdrawnId = (await BrainEntry.findOne({ slug: withdrawn.entry.slug }))!._id.toString();
    expect(runtime.index.hasEntry(withdrawnId)).toBe(false);
    expect(runtime.index.fts('"4320"', { scopes: ['core'] }, 5)).toHaveLength(0);
    expect(runtime.index.pendingCatchUp()).not.toBeNull();

    // The next start replays what the swap was owed before it serves.
    runtime.index.close();
    const restarted = createBrainRuntime(runtime.config, { embedder: runtime.embedder });
    await resumeCatchUp(restarted);
    expect(restarted.index.fts('"4320"', { scopes: ['core'] }, 5)).toHaveLength(1);
    expect(restarted.index.fts('"4310"', { scopes: ['core'] }, 5)).toHaveLength(0);
    expect(restarted.index.hasEntry(withdrawnId)).toBe(false);
    expect(restarted.index.pendingCatchUp()).toBeNull();
    restarted.index.close();
  });

  it('queues a reindex requested while the previous retired handle is still draining, instead of answering with the old done', async () => {
    const { runtime, dbPath } = makeRuntime();
    await runtime.store.note(actor, { title: 'Ports', body: 'the preview server listens on 4310', kind: 'reference' });
    let finishEmbedding!: () => void;
    const gate = new Promise<void>((resolve) => { finishEmbedding = resolve; });
    const realEmbedQuery = runtime.embedder.embedQuery.bind(runtime.embedder);
    vi.spyOn(runtime.embedder, 'embedQuery').mockImplementationOnce(async (text) => { await gate; return realEmbedQuery(text); });
    const inFlight = searchBrain(runtime, 'test', { query: 'preview server 4310' });
    startReindex(runtime);
    const first = await waitForReindex();
    expect(first.state).toBe('done');
    // The retired handle is still held by the parked search. The next request is accepted as its own run (state
    // running, a new startedAt: the operator is not handed the previous run's `done`), but it waits for the drain,
    // so `.previous` stays in place under the old handle until the search releases it.
    const queued = startReindex(runtime);
    expect(queued.state).toBe('running');
    expect(queued.startedAt).not.toBe(first.startedAt);
    expect(startReindex(runtime).startedAt).toBe(queued.startedAt);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(getReindexStatus().state).toBe('running');
    expect(existsSync(`${dbPath}.previous`)).toBe(true);
    finishEmbedding();
    await inFlight;
    const second = await waitForReindex();
    expect(second).toMatchObject({ state: 'done', startedAt: queued.startedAt });
    expect(existsSync(`${dbPath}.previous`)).toBe(false);
    runtime.index.close();
  });

  it('restores the previous index when the rebuilt file cannot be opened', async () => {
    const { runtime, dbPath } = makeRuntime();
    await runtime.store.note(actor, { title: 'Keep', body: 'kept across a failed swap', kind: 'memory' });
    let failures = 0;
    const openIndex: typeof openBrainIndex = (opts) => {
      if (opts.path === dbPath && failures++ === 0) {
        throw new Error('disk on fire');
      }
      return openBrainIndex(opts);
    };
    startReindex(runtime, { openIndex });
    expect(await waitForReindex()).toMatchObject({ state: 'failed', error: 'disk on fire' });
    expect(existsSync(dbPath)).toBe(true);
    expect(existsSync(`${dbPath}.previous`)).toBe(false);
    expect(existsSync(`${dbPath}.rebuild`)).toBe(false);
    expect(runtime.index.counts().entries).toBe(1);
    await runtime.store.note(actor, { title: 'After', body: 'still writable after rollback', kind: 'memory' });
    expect(runtime.index.counts().entries).toBe(2);
    runtime.index.close();
  });

  it('reports a failure when the rebuild file cannot even be opened, and frees the slot', async () => {
    const { runtime, dbPath } = makeRuntime();
    const openIndex: typeof openBrainIndex = (opts) => {
      if (opts.path === `${dbPath}.rebuild`) {
        throw new Error('disk full');
      }
      return openBrainIndex(opts);
    };
    startReindex(runtime, { openIndex });
    expect(await waitForReindex()).toMatchObject({ state: 'failed', error: 'disk full' });
    expect(runtime.index.counts()).toEqual({ entries: 0, chunks: 0 });
    expect(startReindex(runtime).state).toBe('running');
    expect((await waitForReindex()).state).toBe('done');
    runtime.index.close();
  });

  it('rolls back when the rebuilt file vanishes before the swap', async () => {
    const { runtime, dbPath } = makeRuntime();
    await runtime.store.note(actor, { title: 'Keep', body: 'kept across a vanished rebuild', kind: 'memory' });
    // The rebuild handle deletes its own file on close, so the swap's rename fails after the live file moved aside.
    const openIndex: typeof openBrainIndex = (opts) => {
      const real = openBrainIndex(opts);
      if (opts.path !== `${dbPath}.rebuild`) {
        return real;
      }
      return new Proxy(real, {
        get: (target, prop, receiver) => (prop === 'close' ? () => { target.close(); rmSync(opts.path, { force: true }); } : Reflect.get(target, prop, receiver)),
      });
    };
    startReindex(runtime, { openIndex });
    expect(await waitForReindex()).toMatchObject({ state: 'failed' });
    expect(getReindexStatus().error).toMatch(/ENOENT/u);
    expect(existsSync(dbPath)).toBe(true);
    expect(existsSync(`${dbPath}.previous`)).toBe(false);
    expect(runtime.index.counts().entries).toBe(1);
    await runtime.store.note(actor, { title: 'After', body: 'still writable after the vanished rebuild', kind: 'memory' });
    expect(runtime.index.counts().entries).toBe(2);
    runtime.index.close();
  });

  it('puts an interrupted swap back before the runtime opens the index', () => {
    const { runtime, dbPath } = makeRuntime();
    runtime.index.close();
    moveIndexFiles(dbPath, `${dbPath}.previous`);
    expect(existsSync(dbPath)).toBe(false);
    expect(recoverInterruptedSwap(dbPath)).toBe('restored');
    expect(existsSync(dbPath)).toBe(true);
    expect(existsSync(`${dbPath}.previous`)).toBe(false);
    expect(recoverInterruptedSwap(dbPath)).toBe('none');
    // A completed swap whose retire cleanup never ran leaves both files; keep .previous for the recall merge.
    writeFileSync(`${dbPath}.previous`, '');
    expect(recoverInterruptedSwap(dbPath)).toBe('stale-previous');
    expect(existsSync(`${dbPath}.previous`)).toBe(true);
  });

  it('reports a running job instead of starting a second one', async () => {
    const { runtime } = makeRuntime();
    const first = startReindex(runtime);
    const second = startReindex(runtime);
    expect(second.startedAt).toBe(first.startedAt);
    await waitForReindex();
    expect(getReindexStatus().state).toBe('done');
    runtime.index.close();
  });
});
