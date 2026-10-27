import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import mongoose from 'mongoose';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { clearTestDb, setupTestDb, teardownTestDb } from '../test-support/mongo.js';
import { testConfig, testIdentity } from '../test-support/brain.js';
import { createFakeEmbedder } from './embeddings/index.js';
import { type BrainIndex, openBrainIndex } from './index/sqlite.js';
import { BrainEntry, type IBrainEntryDocument } from './model.js';
import { BrainConflictError, type BrainEntryView, BrainInputError, BrainNotFoundError, BrainStore } from './store.js';
import { rowFor } from './store-index.js';

const config = testConfig();
const identity = testIdentity(config);
const actor = { agent: 'codex@laptop', originClass: 'agent' as const };

describe('BrainStore', () => {
  let index: BrainIndex;
  let store: BrainStore;

  beforeAll(setupTestDb);
  afterAll(teardownTestDb);
  afterEach(() => { vi.restoreAllMocks(); });
  beforeEach(async () => {
    await clearTestDb();
    index = openBrainIndex({ path: ':memory:', identity });
    store = new BrainStore({ index, embedder: createFakeEmbedder(32), config });
  });

  it('writes keyword-only rows while the index is stale instead of inserting mismatched vectors', async () => {
    const path = join(mkdtempSync(join(tmpdir(), 'brain-stale-')), 'brain.sqlite');
    openBrainIndex({ path, identity }).close();
    const stale = openBrainIndex({ path, identity: { ...identity, embedDims: 16 } });
    expect(stale.stale).toBe(true);
    const embedder = createFakeEmbedder(16);
    const embedDocuments = vi.spyOn(embedder, 'embedDocuments');
    const staleStore = new BrainStore({ index: stale, embedder, config: testConfig({ BRAIN_EMBED_DIMS: '16' }) });
    const { created } = await staleStore.note(actor, { title: 'Stale', body: 'written while stale', kind: 'memory' });
    expect(created).toBe(true);
    expect(embedDocuments).not.toHaveBeenCalled();
    expect(stale.fts('"stale"', { scopes: ['core'] }, 5)).toHaveLength(1);
    stale.close();
  });

  it('creates an episodic entry, dedupes by content, and indexes it', async () => {
    const first = await store.note(actor, { title: 'Use pnpm', body: 'Use pnpm, never npm.', kind: 'memory', tags: ['tooling', ' tooling ', ''] });
    expect(first.created).toBe(true);
    expect(first.entry).toMatchObject({ tier: 'episodic', originClass: 'agent', authorAgent: 'codex@laptop', namespace: 'shared', tags: ['tooling'], importance: 5 });
    expect(first.entry.slug).toMatch(/^use-pnpm-[0-9a-f]{6}$/u);
    const second = await store.note(actor, { title: 'dupe', body: 'Use pnpm, never npm.', kind: 'memory' });
    expect(second.created).toBe(false);
    expect(second.entry.slug).toBe(first.entry.slug);
    expect((await store.list({}, { page: 1, limit: 10 })).items).toHaveLength(1);
    expect(index.counts()).toEqual({ entries: 1, chunks: 1 });
    expect(index.fts('"pnpm"', { scopes: ['core'] }, 5)).toHaveLength(1);
  });

  it('collapses concurrent identical notes to one entry', async () => {
    const input = { title: 'Race', body: 'two agents saved this at once', kind: 'memory' as const };
    const [a, b] = await Promise.all([store.note(actor, input), store.note(actor, input)]);
    expect(a.entry.slug).toBe(b.entry.slug);
    expect([a.created, b.created].filter(Boolean)).toHaveLength(1);
    expect(await BrainEntry.countDocuments({ contentHash: a.entry.contentHash })).toBe(1);
    expect(index.counts().entries).toBe(1);
  });

  it('rejects secrets, bad namespaces, bad importance, and blank bodies', async () => {
    await expect(store.note(actor, { title: 't', body: `token bbk_${'a'.repeat(43)}`, kind: 'memory' })).rejects.toBeInstanceOf(BrainInputError);
    await expect(store.note(actor, { title: `ghp_${'a'.repeat(24)}`, body: 'x', kind: 'memory' })).rejects.toThrow(/title contains a secret-shaped value/u);
    await expect(store.note(actor, { title: 't', body: 'x', kind: 'memory', tags: ['ok', `AKIA${'B'.repeat(16)}`] })).rejects.toThrow(/a tag contains a secret-shaped value/u);
    const { entry } = await store.note(actor, { title: 'clean', body: 'clean body', kind: 'memory' });
    await expect(store.supersede(actor, entry.slug, { body: 'still clean', reason: `see xoxb-${'1'.repeat(12)}`, expectedHash: entry.contentHash })).rejects.toThrow(/reason contains a secret-shaped value/u);
    await expect(store.forget(actor, { slug: entry.slug }, `Bearer ${'t'.repeat(20)}`)).rejects.toThrow(/reason contains a secret-shaped value/u);
    await expect(store.note(actor, { title: 't', body: 'x', kind: 'memory', source: { system: 'import', externalId: `key-AKIA${'C'.repeat(16)}.md` } })).rejects.toThrow(/source contains a secret-shaped value/u);
    const leakyKey = { agent: `ghp_${'k'.repeat(24)}`, originClass: 'agent' as const };
    await expect(store.note(leakyKey, { title: 't', body: 'x', kind: 'memory' })).rejects.toThrow(/agent name contains a secret-shaped value/u);
    await expect(store.forget(leakyKey, { slug: entry.slug }, 'x')).rejects.toThrow(/agent name contains a secret-shaped value/u);
    expect(await store.get(entry.slug)).not.toBeNull();
    await expect(store.note(actor, { title: 't', body: 'x', kind: 'memory', namespace: 'team:x' })).rejects.toBeInstanceOf(BrainInputError);
    await expect(store.note(actor, { title: 't', body: 'x', kind: 'memory', importance: 11 })).rejects.toBeInstanceOf(BrainInputError);
    await expect(store.note(actor, { title: 't', body: '   ', kind: 'memory' })).rejects.toBeInstanceOf(BrainInputError);
  });

  it('supersedes with hash CAS and keeps history readable', async () => {
    const { entry } = await store.note(actor, { title: 'Port', body: 'the preview server is on 4300', kind: 'reference' });
    await expect(store.supersede(actor, entry.slug, { body: 'x', reason: 'r', expectedHash: 'wrong' })).rejects.toBeInstanceOf(BrainConflictError);
    await expect(store.supersede(actor, 'nope', { body: 'x', reason: 'r', expectedHash: 'h' })).rejects.toBeInstanceOf(BrainNotFoundError);
    const next = await store.supersede(actor, entry.slug, { body: 'the preview server is on 4310', reason: 'port moved', expectedHash: entry.contentHash });
    expect(next.source).toMatchObject({ system: 'supersede', externalId: entry.slug, path: 'port moved' });
    const old = await store.get(entry.slug);
    expect(old?.supersededBy).toBe(next.slug);
    expect(old?.invalidAt).not.toBeNull();
    const fresh = await store.get(next.slug);
    expect(fresh?.history.map((h) => h.slug)).toEqual([entry.slug]);
    expect(fresh?.body).toBe('the preview server is on 4310');
    expect((await store.list({}, { page: 1, limit: 10 })).items.map((i) => i.slug)).toEqual([next.slug, entry.slug]);
    expect(index.fts('"4300"', { scopes: ['core'] }, 5)).toHaveLength(0);
    expect(index.fts('"4300"', { scopes: ['core'], includeSuperseded: true }, 5)).toHaveLength(1);
  });

  it('leaves a forgotten earlier version out of history but keeps walking to older ones', async () => {
    const { entry: v1 } = await store.note(actor, { title: 'Port', body: 'the preview server is on 4300', kind: 'reference' });
    const v2 = await store.supersede(actor, v1.slug, { body: 'the preview server is on 4310', reason: 'moved', expectedHash: v1.contentHash });
    const v3 = await store.supersede(actor, v2.slug, { body: 'the preview server is on 4320', reason: 'moved again', expectedHash: v2.contentHash });
    expect((await store.get(v3.slug))?.history.map((h) => h.slug)).toEqual([v2.slug, v1.slug]);
    expect(await store.forget(actor, { slug: v2.slug }, 'wrong port')).toEqual({ forgotten: 1 });
    expect((await store.get(v3.slug))?.history.map((h) => h.slug)).toEqual([v1.slug]);
    expect(await store.get(v2.slug)).toBeNull();
  });

  it('lists only current versions, or one author\'s entries, on request', async () => {
    const { entry } = await store.note(actor, { title: 'Port', body: 'the preview server is on 4300', kind: 'reference' });
    const next = await store.supersede(actor, entry.slug, { body: 'the preview server is on 4310', reason: 'port moved', expectedHash: entry.contentHash });
    await store.note({ agent: 'claude-code@laptop', originClass: 'agent' }, { title: 'Other', body: 'from another agent', kind: 'memory' });
    const slugs = async (filter: Parameters<BrainStore['list']>[0]) => (await store.list(filter, { page: 1, limit: 10 })).items.map((i) => i.slug);
    expect(await slugs({ current: true })).not.toContain(entry.slug);
    expect(await slugs({ current: true })).toContain(next.slug);
    expect(await slugs({ authorAgent: 'codex@laptop' })).toEqual([next.slug, entry.slug]);
    expect(await slugs({ authorAgent: 'codex@laptop', current: true })).toEqual([next.slug]);
  });

  it('lists every version newest first from an index, so a large brain never hits the in-memory sort cap', async () => {
    // Production (Atlas, 32 MB blocking-sort cap, no spilling to disk) failed every brain_list page past
    // ~1,075 entries ("Sort exceeded memory limit"). A 64 KiB cap reproduces that with thirty 8 KB notes.
    const admin = mongoose.connection.db!.admin();
    const settings = { internalQueryMaxBlockingSortMemoryUsageBytes: 64 * 1024, allowDiskUseByDefault: false };
    const previous = await admin.command({ getParameter: 1, ...Object.fromEntries(Object.keys(settings).map((key) => [key, 1])) });
    await admin.command({ setParameter: 1, ...settings });
    try {
      for (let i = 0; i < 30; i++) {
        await store.note(actor, { title: `Bulk ${i}`, body: `${i} ${'x'.repeat(8_000)}`, kind: 'memory' });
      }
      const oldest = Array.from({ length: 10 }, (_, i) => `Bulk ${9 - i}`);
      // Unfiltered, and filtered by fields other indexes lead with (the planner must still pick the ordered index).
      for (const filter of [{}, { kind: 'memory' as const }, { namespaces: ['shared'] }, { tier: 'episodic' as const }]) {
        const page = await store.list(filter, { page: 3, limit: 10 });
        expect(page.items.map((item) => item.title)).toEqual(oldest);
        expect(page.hasMore).toBe(false);
      }
    } finally {
      await admin.command({ setParameter: 1, ...Object.fromEntries(Object.keys(settings).map((key) => [key, previous[key]])) });
    }
  });

  it('forgets one entry by import identity, a whole source only through the distinct operator selector, and the index forgets too', async () => {
    const { entry } = await store.note(actor, { title: 'A', body: 'alpha text', kind: 'memory', source: { system: 'claude-memory', externalId: 'example/a.md' } });
    const second = await store.note(actor, { title: 'A2', body: 'alpha two text', kind: 'memory', source: { system: 'claude-memory', externalId: 'example/a2.md' } });
    await store.note(actor, { title: 'B', body: 'beta text', kind: 'memory' });
    // An identity selects exactly one import; the other entry of the same system is untouched.
    expect(await store.forget(actor, { source: { system: 'claude-memory', externalId: 'example/a.md' } }, 'cleanup')).toEqual({ forgotten: 1 });
    expect(await store.get(entry.slug)).toBeNull();
    expect(await store.get(second.entry.slug)).not.toBeNull();
    expect(index.counts().entries).toBe(2);
    await expect(store.forget(actor, {}, 'x')).rejects.toBeInstanceOf(BrainInputError);
    const stored = await BrainEntry.findOne({ slug: entry.slug });
    expect(stored?.forgotten).toMatchObject({ reason: 'cleanup', by: 'codex@laptop' });
    // Exactly one selector: slug and source together would let the source widen the slug's entry to its corrections.
    await expect(store.forget(actor, { slug: second.entry.slug, source: { system: 'claude-memory', externalId: 'example/a2.md' } }, 'both')).rejects.toBeInstanceOf(BrainInputError);
    await expect(store.forget(actor, { source: { system: 'claude-memory', externalId: 'example/a2.md' }, wholeSource: { system: 'claude-memory' } }, 'both')).rejects.toBeInstanceOf(BrainInputError);
    expect(await store.get(second.entry.slug)).not.toBeNull();
    // The whole-source form is its own selector (the operator route's), so it cannot be reached by omitting externalId.
    expect(await store.forget(actor, { wholeSource: { system: 'claude-memory' } }, 'source withdrawn')).toEqual({ forgotten: 1 });
    expect(await store.get(second.entry.slug)).toBeNull();
    expect(index.counts().entries).toBe(1);
  });

  it('clears the index before recording a forget, and a retry clears a leftover row', async () => {
    const { entry } = await store.note(actor, { title: 'Ghost', body: 'ghost text', kind: 'memory' });
    const entryId = (await BrainEntry.findOne({ slug: entry.slug }))!._id.toString();
    vi.spyOn(index, 'removeEntry').mockImplementationOnce(() => {
      throw new Error('sqlite busy');
    });
    await expect(store.forget(actor, { slug: entry.slug }, 'cleanup')).rejects.toThrow('sqlite busy');
    expect((await BrainEntry.findOne({ slug: entry.slug }))?.forgotten).toBeUndefined();
    expect(await store.get(entry.slug)).not.toBeNull();
    // Mongo holds a forget whose index removal never landed.
    await BrainEntry.updateOne({ slug: entry.slug }, { $set: { live: false, forgotten: { at: new Date(), reason: 'earlier', by: 'someone' } } });
    expect(index.hasEntry(entryId)).toBe(true);
    expect(await store.forget(actor, { slug: entry.slug }, 'retry')).toEqual({ forgotten: 0 });
    expect(index.hasEntry(entryId)).toBe(false);
    expect(index.fts('"ghost"', { scopes: ['core'] }, 5)).toHaveLength(0);
  });

  it('does not resurrect an entry forgotten while its embedding was in flight', async () => {
    const embedder = createFakeEmbedder(32);
    const real = embedder.embedDocuments.bind(embedder);
    let open!: () => void;
    const gate = new Promise<void>((resolve) => { open = resolve; });
    vi.spyOn(embedder, 'embedDocuments').mockImplementationOnce(async (inputs) => { await gate; return real(inputs); });
    const slow = new BrainStore({ index, embedder, config });
    const pending = slow.note(actor, { title: 'Race', body: 'forgotten while embedding', kind: 'memory' });
    let doc = await BrainEntry.findOne({ title: 'Race' });
    while (!doc) {
      await new Promise((resolve) => setTimeout(resolve, 5));
      doc = await BrainEntry.findOne({ title: 'Race' });
    }
    expect(await store.forget(actor, { slug: doc.slug }, 'gone before indexed')).toEqual({ forgotten: 1 });
    open();
    await pending;
    expect(index.hasEntry(doc._id.toString())).toBe(false);
    expect(index.fts('"embedding"', { scopes: ['core'] }, 5)).toHaveLength(0);
  });

  it('removes the row again after the save in case a reindex swapped in meanwhile', async () => {
    const { entry } = await store.note(actor, { title: 'Swap', body: 'forgotten during a swap', kind: 'memory' });
    const doc = (await BrainEntry.findOne({ slug: entry.slug }))!;
    const original = BrainEntry.prototype.save;
    const spy = vi.spyOn(BrainEntry.prototype, 'save').mockImplementation(async function (this: IBrainEntryDocument, ...args: unknown[]) {
      const saved = await original.apply(this, args as never);
      if (this.forgotten) {
        spy.mockRestore();
        index.upsertEntry(rowFor(doc), []); // the rebuilt index that swapped in still carried the entry
      }
      return saved;
    });
    expect(await store.forget(actor, { slug: entry.slug }, 'swap race')).toEqual({ forgotten: 1 });
    expect(index.hasEntry(doc._id.toString())).toBe(false);
  });

  it('keeps a note with a future validFrom out of current searches until it applies', async () => {
    const future = new Date(Date.now() + 86_400_000);
    await store.note(actor, { title: 'Scheduled', body: 'future scheduled fact', kind: 'memory', validFrom: future });
    expect(index.fts('"scheduled"', { scopes: ['core'] }, 5)).toHaveLength(0);
    expect(index.fts('"scheduled"', { scopes: ['core'], validAtMs: future.getTime() + 1 }, 5)).toHaveLength(1);
    expect(index.fts('"scheduled"', { scopes: ['core'], includeSuperseded: true }, 5)).toHaveLength(1);
  });

  it('carries changed metadata into the replacement when a re-import changes the body too', async () => {
    const source = { system: 'claude-memory', externalId: 'example/both.md' };
    await store.note(actor, { title: 'Both', body: 'first body', kind: 'memory', source });
    const changed = await store.note(actor, { title: 'Both', body: 'second body', kind: 'reference', namespace: 'repo:example', importance: 9, source });
    expect(changed.created).toBe(true);
    expect(changed.entry).toMatchObject({ kind: 'reference', namespace: 'repo:example', importance: 9 });
  });

  it('re-indexes a metadata-only re-import whose earlier index write failed', async () => {
    const source = { system: 'claude-memory', externalId: 'example/retry.md' };
    await store.note(actor, { title: 'Before', body: 'stable body', kind: 'memory', source });
    vi.spyOn(index, 'upsertEntry').mockImplementationOnce(() => {
      throw new Error('sqlite busy');
    });
    await expect(store.note(actor, { title: 'After', body: 'stable body', kind: 'memory', source })).rejects.toThrow('sqlite busy');
    expect(index.fts('"after"', { scopes: ['core'] }, 5)).toHaveLength(0);
    const retry = await store.note(actor, { title: 'After', body: 'stable body', kind: 'memory', source });
    expect(retry.created).toBe(false);
    expect(index.fts('"after"', { scopes: ['core'] }, 5)).toHaveLength(1);
    expect(index.fts('"before"', { scopes: ['core'] }, 5)).toHaveLength(0);
  });

  it('refreshes governed metadata when a re-import keeps the body but changes the rest', async () => {
    const source = { system: 'claude-memory', externalId: 'example/meta.md', path: 'old/meta.md' };
    const first = await store.note(actor, { title: 'Old title', body: 'same body', kind: 'memory', tags: ['one'], source });
    const owner = { agent: 'importer:ops', originClass: 'owner' as const };
    const again = await store.note(owner, { title: 'New title', body: 'same body', kind: 'reference', tags: ['two'], importance: 8, namespace: 'repo:example', source: { ...source, path: 'new/meta.md' } });
    expect(again.created).toBe(false);
    expect(again.entry.slug).toBe(first.entry.slug);
    expect(again.entry).toMatchObject({ title: 'New title', kind: 'reference', tags: ['two'], importance: 8, namespace: 'repo:example', originClass: 'owner', authorAgent: 'importer:ops' });
    expect(again.entry.source).toMatchObject({ path: 'new/meta.md' });
    expect(index.fts('"new"', { scopes: ['core'] }, 5)).toHaveLength(1);
    expect(index.fts('"old"', { scopes: ['core'] }, 5)).toHaveLength(0);
  });

  it('repairs a promotion whose index write failed when it is retried', async () => {
    const { entry } = await store.note(actor, { title: 'Rule', body: 'promotion will be retried', kind: 'memory' });
    vi.spyOn(index, 'upsertEntry').mockImplementationOnce(() => {
      throw new Error('sqlite busy');
    });
    await expect(store.promote(entry.slug, { standing: false })).rejects.toThrow('sqlite busy');
    const curated = await BrainEntry.findOne({ tier: 'curated' });
    expect(index.hasEntry(curated!._id.toString())).toBe(false);
    const retried = await store.promote(entry.slug, { standing: true });
    expect(retried.slug).toBe(curated!.slug);
    expect(retried.tags).toContain('standing');
    expect(index.hasEntry(curated!._id.toString())).toBe(true);
    expect(await BrainEntry.countDocuments({ tier: 'curated' })).toBe(1);
  });

  it('flags curated copies of a forgotten source for review in Mongo and in the index', async () => {
    const { entry } = await store.note(actor, { title: 'Rule', body: 'source that will be forgotten', kind: 'memory' });
    const curated = await store.promote(entry.slug, { standing: false });
    expect(await store.forget(actor, { slug: entry.slug }, 'retracted')).toEqual({ forgotten: 1 });
    const stored = await BrainEntry.findOne({ slug: curated.slug });
    expect(stored?.tags).toContain('needs-review');
    expect(index.fts('"needs-review"', { scopes: ['core'], tier: 'curated' }, 5)).toHaveLength(1);
  });

  it('a forget retry repairs a dependent whose review tag or index row failed to land', async () => {
    const { entry } = await store.note(actor, { title: 'Rule', body: 'source forgotten, copy left behind', kind: 'memory' });
    const curated = await store.promote(entry.slug, { standing: false });
    expect(await store.forget(actor, { slug: entry.slug }, 'retracted')).toEqual({ forgotten: 1 });
    // As if the dependent's save and index write had failed after the source was forgotten.
    await BrainEntry.updateOne({ slug: curated.slug }, { $pull: { tags: 'needs-review' } });
    index.removeEntry((await BrainEntry.findOne({ slug: curated.slug }))!._id.toString());
    expect(await store.forget(actor, { slug: entry.slug }, 'retracted')).toEqual({ forgotten: 0 });
    expect((await BrainEntry.findOne({ slug: curated.slug }))?.tags).toContain('needs-review');
    expect(index.fts('"needs-review"', { scopes: ['core'], tier: 'curated' }, 5)).toHaveLength(1);
  });

  it('demotes curated copies when their source is re-imported as untrusted', async () => {
    const source = { system: 'clippings', externalId: 'web/1' };
    const { entry } = await store.note(actor, { title: 'Clip', body: 'clipped text', kind: 'doc', source });
    const curated = await store.promote(entry.slug, { standing: true });
    const untrusted = { agent: 'importer:ops', originClass: 'untrusted' as const };
    await store.note(untrusted, { title: 'Clip', body: 'clipped text', kind: 'doc', source });
    const copy = await BrainEntry.findOne({ slug: curated.slug });
    expect(copy?.originClass).toBe('untrusted');
    expect(copy?.tags).not.toContain('standing');
    expect(copy?.tags).toContain('needs-review');
    expect(index.fts('"needs-review"', { scopes: ['core'], tier: 'curated' }, 5)).toHaveLength(1);
  });

  it('demotes the whole curated lineage, including the live successor of a superseded copy', async () => {
    const source = { system: 'clippings', externalId: 'web/3' };
    const { entry } = await store.note(actor, { title: 'Clip', body: 'clip three', kind: 'doc', source });
    const promoted = await store.promote(entry.slug, { standing: true });
    const owner = { agent: 'owner', originClass: 'owner' as const };
    const successor = await store.supersede(owner, promoted.slug, { body: 'clip three, reworded', reason: 'tidy', expectedHash: promoted.contentHash });
    expect(successor.tags).toContain('standing');
    await store.note({ agent: 'importer:ops', originClass: 'untrusted' as const }, { title: 'Clip', body: 'clip three', kind: 'doc', source });
    const live = await BrainEntry.findOne({ slug: successor.slug });
    expect(live?.originClass).toBe('untrusted');
    expect(live?.tags).not.toContain('standing');
    expect(live?.tags).toContain('needs-review');
    expect((await BrainEntry.findOne({ slug: promoted.slug }))?.originClass).toBe('untrusted');
  });

  it('repairs curated copies on a retried untrusted import even when the source already carries the downgrade', async () => {
    const source = { system: 'clippings', externalId: 'web/2' };
    const { entry } = await store.note(actor, { title: 'Clip', body: 'clip two', kind: 'doc', source });
    const curated = await store.promote(entry.slug, { standing: true });
    // As if an earlier untrusted import saved the source but failed before demoting the copies.
    await BrainEntry.updateOne({ slug: entry.slug }, { $set: { originClass: 'untrusted', authorAgent: 'importer:ops' } });
    const untrusted = { agent: 'importer:ops', originClass: 'untrusted' as const };
    await store.note(untrusted, { title: 'Clip', body: 'clip two', kind: 'doc', source });
    const copy = await BrainEntry.findOne({ slug: curated.slug });
    expect(copy?.originClass).toBe('untrusted');
    expect(copy?.tags).not.toContain('standing');
  });

  it('keeps an agent\'s correction of untrusted text untrusted, so it is never promoted', async () => {
    const untrusted = { agent: 'importer:ops', originClass: 'untrusted' as const };
    const clip = await store.note(untrusted, { title: 'Clipping', body: 'text someone else wrote', kind: 'doc', source: { system: 'clippings', externalId: 'web/launder' } });
    const corrected = await store.supersede(actor, clip.entry.slug, { body: 'text someone else wrote, lightly edited', reason: 'tidy', expectedHash: clip.entry.contentHash });
    expect(corrected).toMatchObject({ originClass: 'untrusted', authorAgent: actor.agent });
    await expect(store.promote(corrected.slug, { standing: true })).rejects.toBeInstanceOf(BrainInputError);
    const owner = { agent: 'owner', originClass: 'owner' as const };
    expect((await store.supersede(owner, corrected.slug, { body: 'reviewed by the owner', reason: 'vouch', expectedHash: corrected.contentHash })).originClass).toBe('owner');
  });

  it('finds the curated copy of a long lineage, past any number of supersedes', async () => {
    let current = (await store.note(actor, { title: 'Rule', body: 'version 0', kind: 'memory' })).entry;
    const copy = await store.promote(current.slug, { standing: true });
    for (let i = 1; i <= 22; i++) {
      current = await store.supersede(actor, current.slug, { body: `version ${i}`, reason: 'revise', expectedHash: current.contentHash });
    }
    await store.promote(current.slug, { standing: true });
    expect(await BrainEntry.countDocuments({ tier: 'curated', live: true })).toBe(1);
    expect((await store.get(copy.slug))?.supersededBy).not.toBeNull();
  });

  it('a retried re-import repairs the index row of the version it retired, so the old text stops reading as current', async () => {
    const source = { system: 'claude-memory', externalId: 'example/retry-retired.md' };
    await store.note(actor, { title: 'Doc', body: 'the old text', kind: 'memory', source });
    // The changed import retires the old version in Mongo, then fails on that version's index write.
    vi.spyOn(index, 'upsertEntry').mockImplementationOnce(() => { throw new Error('sqlite busy'); });
    await expect(store.note(actor, { title: 'Doc', body: 'the new text', kind: 'memory', source })).rejects.toThrow('sqlite busy');
    expect(index.fts('"old"', { scopes: ['core'] }, 5)).toHaveLength(1);
    const retry = await store.note(actor, { title: 'Doc', body: 'the new text', kind: 'memory', source });
    expect(retry.created).toBe(false);
    expect(index.fts('"old"', { scopes: ['core'] }, 5)).toHaveLength(0);
    expect(index.fts('"new"', { scopes: ['core'] }, 5)).toHaveLength(1);
  });

  it('never promotes an untrusted entry', async () => {
    const untrusted = { agent: 'importer:ops', originClass: 'untrusted' as const };
    const { entry } = await store.note(untrusted, { title: 'Clipping', body: 'text from an untrusted source', kind: 'doc' });
    await expect(store.promote(entry.slug, { standing: true })).rejects.toBeInstanceOf(BrainInputError);
    expect(await BrainEntry.countDocuments({ tier: 'curated' })).toBe(0);
  });

  it('promote copies to curated, and reindexAll rebuilds an empty index', async () => {
    const { entry } = await store.note(actor, { title: 'Standing', body: 'The owner prefers pnpm.', kind: 'memory' });
    const curated = await store.promote(entry.slug, { standing: true });
    expect(curated.tier).toBe('curated');
    expect(curated.tags).toContain('standing');
    expect(curated.source).toMatchObject({ system: 'promote', externalId: entry.slug });
    const fresh = new BrainStore({ index: openBrainIndex({ path: ':memory:', identity }), embedder: createFakeEmbedder(32), config });
    expect(await fresh.reindexAll()).toEqual({ entries: 2, chunks: 2 });
  });

  it('re-importing a changed source supersedes the earlier import and keeps its identity', async () => {
    const source = { system: 'claude-memory', externalId: 'example/ports.md' };
    const first = await store.note(actor, { title: 'Ports', body: 'the preview server is on 4300', kind: 'reference', source });
    const same = await store.note(actor, { title: 'Ports', body: 'the preview server is on 4300', kind: 'reference', source });
    expect(same.created).toBe(false);
    expect(same.entry.slug).toBe(first.entry.slug);
    const changed = await store.note(actor, { title: 'Ports', body: 'the preview server is on 4310', kind: 'reference', source });
    expect(changed.created).toBe(true);
    expect(changed.entry.slug).not.toBe(first.entry.slug);
    expect(changed.entry.source).toMatchObject(source);
    const old = await store.get(first.entry.slug);
    expect(old?.supersededBy).toBe(changed.entry.slug);
    expect((await store.get(changed.entry.slug))?.history.map((h) => h.slug)).toEqual([first.entry.slug]);
    await expect(store.supersede(actor, first.entry.slug, { body: 'x', reason: 'r', expectedHash: first.entry.contentHash })).rejects.toBeInstanceOf(BrainInputError);
    expect(index.fts('"4300"', { scopes: ['core'] }, 5)).toHaveLength(0);
    expect(index.fts('"4310"', { scopes: ['core'] }, 5)).toHaveLength(1);
  });

  it('follows an import through an agent supersede: an unchanged source leaves the correction, a changed one replaces it', async () => {
    const source = { system: 'claude-memory', externalId: 'example/mcp.md' };
    const imported = await store.note(actor, { title: 'MCP', body: 'the preview server is on 4300', kind: 'reference', source });
    const corrected = await store.supersede(actor, imported.entry.slug, { body: 'the preview server is on 4310', reason: 'moved', expectedHash: imported.entry.contentHash });
    const unchanged = await store.note(actor, { title: 'MCP', body: 'the preview server is on 4300', kind: 'reference', source });
    expect(unchanged.created).toBe(false);
    expect(unchanged.entry.slug).toBe(corrected.slug);
    expect(await BrainEntry.countDocuments({ live: true })).toBe(1);
    const changed = await store.note(actor, { title: 'MCP', body: 'the preview server is on 4320', kind: 'reference', source });
    expect(changed.created).toBe(true);
    expect(changed.entry.source).toMatchObject(source);
    expect((await store.get(corrected.slug))?.supersededBy).toBe(changed.entry.slug);
    expect((await store.get(changed.entry.slug))?.history.map((h) => h.slug)).toEqual([corrected.slug, imported.entry.slug]);
    expect(await BrainEntry.countDocuments({ live: true })).toBe(1);
    expect(index.fts('"4310"', { scopes: ['core'] }, 5)).toHaveLength(0);
    expect(index.fts('"4320"', { scopes: ['core'] }, 5)).toHaveLength(1);
  });

  it('records a re-import that matches the current correction, so the source changing back replaces it', async () => {
    const source = { system: 'claude-memory', externalId: 'example/preview.md' };
    const imported = await store.note(actor, { title: 'Preview', body: 'the preview server is on 4300', kind: 'reference', source });
    const corrected = await store.supersede(actor, imported.entry.slug, { body: 'the preview server is on 4310', reason: 'moved', expectedHash: imported.entry.contentHash });
    // The source now says what the correction says: the correction stays current, and the same snapshot again writes nothing.
    const snapshot = { title: 'Preview', body: 'the preview server is on 4310', kind: 'reference' as const, source };
    expect(await store.note(actor, snapshot)).toMatchObject({ created: false, entry: { slug: corrected.slug } });
    const rows = await BrainEntry.countDocuments();
    expect(await store.note(actor, snapshot)).toMatchObject({ created: false, entry: { slug: corrected.slug } });
    expect(await BrainEntry.countDocuments()).toBe(rows);
    expect(await BrainEntry.countDocuments({ live: true })).toBe(1);
    // The source changes back to the text first imported: a change since the last snapshot, so it replaces the correction.
    const reverted = await store.note(actor, { title: 'Preview', body: 'the preview server is on 4300', kind: 'reference', source });
    expect(reverted.created).toBe(true);
    expect(reverted.entry.source).toMatchObject(source);
    expect((await store.get(corrected.slug))?.supersededBy).toBe(reverted.entry.slug);
    expect(await BrainEntry.countDocuments({ live: true })).toBe(1);
    expect(index.fts('"4310"', { scopes: ['core'] }, 5)).toHaveLength(0);
    expect(index.fts('"4300"', { scopes: ['core'] }, 5)).toHaveLength(1);
    // The first import, the recorded snapshot, the correction and the revert all go with the source.
    expect(await store.forget(actor, { source }, 'source withdrawn')).toEqual({ forgotten: 4 });
  });

  it('takes an import\'s latest snapshot by insertion order when two share a creation time', async () => {
    const source = { system: 'claude-memory', externalId: 'example/tie.md' };
    const imported = await store.note(actor, { title: 'Tie', body: 'the tie server is on 4400', kind: 'reference', source });
    await store.supersede(actor, imported.entry.slug, { body: 'the tie server is on 4410', reason: 'moved', expectedHash: imported.entry.contentHash });
    await store.note(actor, { title: 'Tie', body: 'the tie server is on 4410', kind: 'reference', source });
    // The first import and the recorded snapshot, created in the same millisecond.
    const first = await BrainEntry.findOne({ slug: imported.entry.slug }).lean();
    await BrainEntry.collection.updateMany({ 'source.system': source.system, 'source.externalId': source.externalId }, { $set: { createdAt: first!.createdAt } });
    const reverted = await store.note(actor, { title: 'Tie', body: 'the tie server is on 4400', kind: 'reference', source });
    expect(reverted.created).toBe(true);
  });

  it('forgetting by source retires the agent supersede that is the import\'s current version', async () => {
    const source = { system: 'clippings', externalId: 'web/9' };
    const imported = await store.note(actor, { title: 'Clip', body: 'clipped claim', kind: 'doc', source });
    const corrected = await store.supersede(actor, imported.entry.slug, { body: 'clipped claim, corrected', reason: 'fix', expectedHash: imported.entry.contentHash });
    expect(await store.forget(actor, { source }, 'source withdrawn')).toEqual({ forgotten: 2 });
    expect(await store.get(corrected.slug)).toBeNull();
    expect(index.fts('"corrected"', { scopes: ['core'] }, 5)).toHaveLength(0);
  });

  it('a fold target is not a version of the import: forgetting or changing the source leaves it alone', async () => {
    const source = { system: 'clippings', externalId: 'web/11' };
    const twin = await store.note(actor, { title: 'Own note', body: 'a fact written by the agent', kind: 'memory' });
    await store.note(actor, { title: 'Clip', body: 'clip eleven', kind: 'doc', source });
    const folded = await store.note(actor, { title: 'Clip', body: 'a fact written by the agent', kind: 'doc', source });
    expect(folded.created).toBe(false);
    expect(folded.entry.slug).toBe(twin.entry.slug);
    const changed = await store.note(actor, { title: 'Clip', body: 'clip eleven, revised', kind: 'doc', source });
    expect(changed.created).toBe(true);
    expect(changed.entry.source).toMatchObject(source);
    // The first import, the snapshot recorded as folded into the twin, and the revision: never the twin itself.
    expect(await store.forget(actor, { source }, 'source withdrawn')).toEqual({ forgotten: 3 });
    expect(await store.get(twin.entry.slug)).not.toBeNull();
    expect(index.fts('"written"', { scopes: ['core'] }, 5)).toHaveLength(1);
    expect(index.fts('"revised"', { scopes: ['core'] }, 5)).toHaveLength(0);
  });

  it('records a later capture time on a retired import version when a re-import writes nothing, leaving updatedAt alone', async () => {
    const day = (n: number): Date => new Date(Date.UTC(2026, 9, n));
    // An agent's correction is the current version.
    const corrected = { system: 'clippings', externalId: 'web/13' };
    const imported = await store.note(actor, { title: 'Clip', body: 'clip thirteen', kind: 'doc', source: { ...corrected, capturedAt: day(1) } });
    await store.supersede(actor, imported.entry.slug, { body: 'clip thirteen, corrected', reason: 'fix', expectedHash: imported.entry.contentHash });
    const before = await BrainEntry.findOne({ slug: imported.entry.slug }).lean();
    const again = await store.note(actor, { title: 'Clip', body: 'clip thirteen', kind: 'doc', source: { ...corrected, capturedAt: day(5) } });
    expect(again.created).toBe(false);
    const after = await BrainEntry.findOne({ slug: imported.entry.slug }).lean();
    expect(after).toMatchObject({ live: false, source: { capturedAt: day(5) } });
    expect(after?.updatedAt).toEqual(before?.updatedAt);
    expect(index.updatedAtOf(String(after?._id))).toBe(after?.updatedAt.getTime());
    await store.note(actor, { title: 'Clip', body: 'clip thirteen', kind: 'doc', source: { ...corrected, capturedAt: day(3) } });
    expect((await BrainEntry.findOne({ slug: imported.entry.slug }).lean())?.source?.capturedAt).toEqual(day(5));

    // A duplicate folded into a body twin.
    const folded = { system: 'clippings', externalId: 'web/14' };
    await store.note(actor, { title: 'Own note', body: 'a fact both carry', kind: 'memory' });
    await store.note(actor, { title: 'Clip', body: 'a fact both carry', kind: 'doc', source: { ...folded, capturedAt: day(1) } });
    await store.note(actor, { title: 'Clip', body: 'a fact both carry', kind: 'doc', source: { ...folded, capturedAt: day(6) } });
    expect(await BrainEntry.findOne({ 'source.system': 'clippings', 'source.externalId': 'web/14' }).lean()).toMatchObject({ live: false, source: { capturedAt: day(6) } });
  });

  it('records a changed import that folds into an existing twin, so re-importing that snapshot writes nothing', async () => {
    const day = (n: number): Date => new Date(Date.UTC(2026, 9, n));
    const source = { system: 'clippings', externalId: 'web/15' };
    await store.note(actor, { title: 'Clip', body: 'clip fifteen', kind: 'doc', source: { ...source, capturedAt: day(1) } });
    const twin = await store.note(actor, { title: 'Own note', body: 'a fact that came later', kind: 'memory' });
    const changed = await store.note(actor, { title: 'Clip', body: 'a fact that came later', kind: 'doc', source: { ...source, capturedAt: day(2) } });

    expect(changed).toMatchObject({ created: false, entry: { slug: twin.entry.slug } });
    const rows = await BrainEntry.find({ 'source.system': 'clippings', 'source.externalId': 'web/15' }).sort({ createdAt: -1, _id: -1 }).lean();
    const twinDoc = await BrainEntry.findOne({ slug: twin.entry.slug }).lean();
    expect(rows[0]).toMatchObject({ live: false, contentHash: twinDoc?.contentHash, source: { capturedAt: day(2) } });
    expect(String(rows[0].supersededBy)).toBe(String(twinDoc?._id));
    const again = await store.note(actor, { title: 'Clip', body: 'a fact that came later', kind: 'doc', source: { ...source, capturedAt: day(3) } });
    expect(again).toMatchObject({ created: false, entry: { slug: twin.entry.slug } });
    expect(await BrainEntry.countDocuments({ 'source.system': 'clippings', 'source.externalId': 'web/15' })).toBe(rows.length);
  });

  it('records a fully retired import that now folds into a different twin, then recognizes it', async () => {
    const source = { system: 'clippings', externalId: 'web/17' };
    const first = await store.note(actor, { title: 'Own note', body: 'shared text', kind: 'memory' });
    await store.note(actor, { title: 'Clip', body: 'shared text', kind: 'doc', source });
    await store.forget(actor, { slug: first.entry.slug }, 'gone');
    const second = await store.note(actor, { title: 'Other note', body: 'shared text', kind: 'memory' });
    expect(second.created).toBe(true);

    expect(await store.note(actor, { title: 'Clip', body: 'shared text', kind: 'doc', source })).toMatchObject({ created: false, entry: { slug: second.entry.slug } });
    const latest = await BrainEntry.findOne({ 'source.system': 'clippings', 'source.externalId': 'web/17' }).sort({ createdAt: -1, _id: -1 }).lean();
    expect(String(latest?.supersededBy)).toBe(String((await BrainEntry.findOne({ slug: second.entry.slug }).lean())?._id));
    const versions = await BrainEntry.countDocuments({ 'source.system': 'clippings', 'source.externalId': 'web/17' });
    await store.note(actor, { title: 'Clip', body: 'shared text', kind: 'doc', source });
    expect(await BrainEntry.countDocuments({ 'source.system': 'clippings', 'source.externalId': 'web/17' })).toBe(versions);
  });

  it('forgets an import\'s corrections before its own versions, so a forget that fails part-way can be retried by its source', async () => {
    const source = { system: 'clippings', externalId: 'web/16' };
    const imported = await store.note(actor, { title: 'Clip', body: 'clip sixteen', kind: 'doc', source });
    const corrected = await store.supersede(actor, imported.entry.slug, { body: 'clip sixteen, corrected', reason: 'fix', expectedHash: imported.entry.contentHash });
    const save = BrainEntry.prototype.save;
    const failing = vi.spyOn(BrainEntry.prototype, 'save').mockImplementation(async function (this: IBrainEntryDocument, ...args: unknown[]) {
      if (this.source?.system === 'clippings' && this.forgotten) {
        throw new Error('write failed');
      }
      return save.apply(this, args as Parameters<typeof save>);
    });

    await expect(store.forget(actor, { source }, 'source withdrawn')).rejects.toThrow('write failed');
    failing.mockRestore();
    expect((await BrainEntry.findOne({ slug: corrected.slug }).lean())?.forgotten).toBeTruthy();
    expect((await BrainEntry.findOne({ slug: imported.entry.slug }).lean())?.forgotten).toBeFalsy();

    expect(await store.forget(actor, { source }, 'source withdrawn')).toEqual({ forgotten: 1 });
    expect((await BrainEntry.findOne({ slug: imported.entry.slug }).lean())?.forgotten).toBeTruthy();
  });

  it('demotes a copy promoted from an agent\'s correction of the import', async () => {
    const source = { system: 'clippings', externalId: 'web/12' };
    const imported = await store.note(actor, { title: 'Clip', body: 'clip twelve', kind: 'doc', source });
    const corrected = await store.supersede(actor, imported.entry.slug, { body: 'clip twelve, corrected', reason: 'fix', expectedHash: imported.entry.contentHash });
    const copy = await store.promote(corrected.slug, { standing: true });
    await store.note({ agent: 'importer:ops', originClass: 'untrusted' as const }, { title: 'Clip', body: 'clip twelve', kind: 'doc', source });
    const demoted = await BrainEntry.findOne({ slug: copy.slug });
    expect(demoted?.originClass).toBe('untrusted');
    expect(demoted?.tags).not.toContain('standing');
    expect(demoted?.tags).toContain('needs-review');
  });

  it('an untrusted re-import downgrades an agent\'s live correction too, so re-promoting it cannot restore the copy', async () => {
    const source = { system: 'clippings', externalId: 'web/20' };
    const imported = await store.note(actor, { title: 'Clip', body: 'clip twenty', kind: 'doc', source });
    const corrected = await store.supersede(actor, imported.entry.slug, { body: 'clip twenty, corrected', reason: 'fix', expectedHash: imported.entry.contentHash });
    const copy = await store.promote(corrected.slug, { standing: true });
    await store.note({ agent: 'importer:ops', originClass: 'untrusted' as const }, { title: 'Clip', body: 'clip twenty', kind: 'doc', source });
    // The correction stays current, now carrying the source's downgrade, in Mongo and in the index.
    expect(await BrainEntry.findOne({ slug: corrected.slug }).lean()).toMatchObject({ live: true, originClass: 'untrusted', authorAgent: actor.agent });
    const rows = index.getChunks(index.fts('"corrected"', { scopes: ['core'], tier: 'episodic' }, 5).map((hit) => hit.chunkId));
    expect(rows.map((row) => [row.slug, row.originClass])).toEqual([[corrected.slug, 'untrusted']]);
    await expect(store.promote(corrected.slug, { standing: true })).rejects.toBeInstanceOf(BrainInputError);
    const after = await BrainEntry.findOne({ slug: copy.slug }).lean();
    expect(after?.originClass).toBe('untrusted');
    expect(after?.tags).not.toContain('standing');
    expect(after?.tags).toContain('needs-review');
  });

  it('an untrusted re-import leaves an owner\'s correction the owner\'s: the owner vouched for that text', async () => {
    const source = { system: 'clippings', externalId: 'web/21' };
    const imported = await store.note(actor, { title: 'Clip', body: 'clip twenty-one', kind: 'doc', source });
    const owner = { agent: 'owner', originClass: 'owner' as const };
    const vouched = await store.supersede(owner, imported.entry.slug, { body: 'clip twenty-one, reviewed', reason: 'vouch', expectedHash: imported.entry.contentHash });
    await store.note({ agent: 'importer:ops', originClass: 'untrusted' as const }, { title: 'Clip', body: 'clip twenty-one', kind: 'doc', source });
    expect(await BrainEntry.findOne({ slug: vouched.slug }).lean()).toMatchObject({ live: true, originClass: 'owner' });
  });

  it('a first import whose body already exists keeps its identity as a retired version of that entry', async () => {
    const source = { system: 'clippings', externalId: 'web/15' };
    const own = await store.note(actor, { title: 'Own', body: 'a body two sources share', kind: 'memory' });
    const first = await store.note(actor, { title: 'Clip', body: 'a body two sources share', kind: 'doc', source });
    expect(first.created).toBe(false);
    expect(first.entry.slug).toBe(own.entry.slug);
    const alias = await BrainEntry.findOne({ 'source.system': source.system, 'source.externalId': source.externalId });
    expect(alias).toMatchObject({ live: false, kind: 'doc' });
    expect(alias?.supersededBy?.toString()).toBe((await BrainEntry.findOne({ slug: own.entry.slug }))!._id.toString());
    const again = await store.note(actor, { title: 'Clip', body: 'a body two sources share', kind: 'doc', source });
    expect(again.created).toBe(false);
    expect(await BrainEntry.countDocuments({ 'source.externalId': source.externalId })).toBe(1);
    const changed = await store.note(actor, { title: 'Clip', body: 'the clipping moved on', kind: 'doc', source });
    expect(changed.created).toBe(true);
    expect(changed.entry.source).toMatchObject(source);
    expect(await store.forget(actor, { source }, 'clippings withdrawn')).toEqual({ forgotten: 2 });
    expect(await store.get(own.entry.slug)).not.toBeNull();
  });

  it('demotes the copies of an import whose every version was retired by a fold', async () => {
    const source = { system: 'clippings', externalId: 'web/13' };
    const imported = await store.note(actor, { title: 'Clip', body: 'clip thirteen', kind: 'doc', source });
    const copy = await store.promote(imported.entry.slug, { standing: true });
    await store.note(actor, { title: 'Own', body: 'an unrelated agent note', kind: 'memory' });
    expect((await store.note(actor, { title: 'Clip', body: 'an unrelated agent note', kind: 'doc', source })).created).toBe(false);
    const again = await store.note({ agent: 'importer:ops', originClass: 'untrusted' as const }, { title: 'Clip', body: 'clip thirteen', kind: 'doc', source });
    expect(again.created).toBe(true);
    expect(again.entry.originClass).toBe('untrusted');
    const demoted = await BrainEntry.findOne({ slug: copy.slug });
    expect(demoted?.originClass).toBe('untrusted');
    expect(demoted?.tags).not.toContain('standing');
    expect(demoted?.tags).toContain('needs-review');
  });

  it('a promotion that races an untrusted downgrade of its source ends demoted', async () => {
    const source = { system: 'clippings', externalId: 'web/14' };
    const { entry } = await store.note(actor, { title: 'Clip', body: 'clip fourteen', kind: 'doc', source });
    const originalCreate = BrainEntry.create.bind(BrainEntry) as (...args: unknown[]) => Promise<unknown>;
    vi.spyOn(BrainEntry, 'create').mockImplementationOnce((async (...args: unknown[]) => {
      // The downgrade lands between promote's read of the source and its insert of the copy.
      await BrainEntry.updateOne({ slug: entry.slug }, { $set: { originClass: 'untrusted' } });
      return originalCreate(...args);
    }) as never);
    const copy = await store.promote(entry.slug, { standing: true });
    expect(copy.originClass).toBe('untrusted');
    expect(copy.tags).not.toContain('standing');
    expect(copy.tags).toContain('needs-review');
    expect(index.fts('"needs-review"', { scopes: ['core'], tier: 'curated' }, 5)).toHaveLength(1);
  });

  it('re-promoting a source whose copy was superseded reuses the live curated successor', async () => {
    const { entry } = await store.note(actor, { title: 'Rule', body: 'the rule as first written', kind: 'memory' });
    const copy = await store.promote(entry.slug, { standing: true });
    const owner = { agent: 'owner', originClass: 'owner' as const };
    const corrected = await store.supersede(owner, copy.slug, { body: 'the rule, corrected by the owner', reason: 'fix', expectedHash: copy.contentHash });
    const again = await store.promote(entry.slug, { standing: true });
    expect(again.slug).toBe(corrected.slug);
    expect((await store.get(again.slug))?.body).toBe('the rule, corrected by the owner');
    expect(await BrainEntry.countDocuments({ tier: 'curated', live: true })).toBe(1);
  });

  it('re-promoting a source that regained trust restores the copy\'s provenance and clears the review tag', async () => {
    const source = { system: 'clippings', externalId: 'web/16' };
    const { entry } = await store.note(actor, { title: 'Clip', body: 'clip sixteen', kind: 'doc', source });
    const copy = await store.promote(entry.slug, { standing: true });
    await store.note({ agent: 'importer:ops', originClass: 'untrusted' as const }, { title: 'Clip', body: 'clip sixteen', kind: 'doc', source });
    expect((await BrainEntry.findOne({ slug: copy.slug }))?.originClass).toBe('untrusted');
    await store.note(actor, { title: 'Clip', body: 'clip sixteen', kind: 'doc', source });
    const restored = await store.promote(entry.slug, { standing: true });
    expect(restored.slug).toBe(copy.slug);
    expect(restored.originClass).toBe('agent');
    expect(restored.tags).toContain('standing');
    expect(restored.tags).not.toContain('needs-review');
    expect(index.fts('"needs-review"', { scopes: ['core'], tier: 'curated' }, 5)).toHaveLength(0);
  });

  it('a re-promotion that restores a copy while a downgrade lands ends demoted', async () => {
    const source = { system: 'clippings', externalId: 'web/17' };
    const { entry } = await store.note(actor, { title: 'Clip', body: 'clip seventeen', kind: 'doc', source });
    const copy = await store.promote(entry.slug, { standing: true });
    await store.note({ agent: 'importer:ops', originClass: 'untrusted' as const }, { title: 'Clip', body: 'clip seventeen', kind: 'doc', source });
    await store.note(actor, { title: 'Clip', body: 'clip seventeen', kind: 'doc', source });
    // The downgrade lands while the copy is being restored (the restore is the in-step compare-and-set).
    const realUpdate = BrainEntry.findOneAndUpdate.bind(BrainEntry) as unknown as (...args: unknown[]) => Promise<unknown>;
    vi.spyOn(BrainEntry, 'findOneAndUpdate').mockImplementationOnce((async (...args: unknown[]) => {
      await BrainEntry.updateOne({ slug: entry.slug }, { $set: { originClass: 'untrusted' } });
      return realUpdate(...args);
    }) as never);
    const restored = await store.promote(entry.slug, { standing: true });
    expect(restored.slug).toBe(copy.slug);
    expect(restored.originClass).toBe('untrusted');
    expect(restored.tags).not.toContain('standing');
    expect(restored.tags).toContain('needs-review');
  });

  it('keeps two tag slots for system tags: a maximally-tagged curated copy still demotes and review-tags', async () => {
    const source = { system: 'clippings', externalId: 'web/18' };
    const userTags = Array.from({ length: 18 }, (_, i) => `t${i}`);
    const { entry } = await store.note(actor, { title: 'Clip', body: 'clip eighteen', kind: 'doc', tags: userTags, source });
    const copy = await store.promote(entry.slug, { standing: true });
    expect(copy.tags).toContain('standing');
    expect(copy.tags.length).toBeLessThanOrEqual(20);
    await store.note({ agent: 'importer:ops', originClass: 'untrusted' as const }, { title: 'Clip', body: 'clip eighteen', kind: 'doc', tags: userTags, source });
    const demoted = await BrainEntry.findOne({ slug: copy.slug });
    expect(demoted?.originClass).toBe('untrusted');
    expect(demoted?.tags).not.toContain('standing');
    expect(demoted?.tags).toContain('needs-review');
    expect(demoted!.tags.length).toBeLessThanOrEqual(20);
    await expect(store.note(actor, { title: 'Too many', body: 'nineteen tags', kind: 'memory', tags: Array.from({ length: 19 }, (_, i) => `x${i}`) })).rejects.toBeInstanceOf(BrainInputError);
  });

  it('rejects a caller-supplied source.system that forges a reserved lineage identity', async () => {
    await expect(store.note(actor, { title: 'A', body: 'forged one', kind: 'memory', source: { system: 'promote', externalId: 'a' } })).rejects.toBeInstanceOf(BrainInputError);
    await expect(store.note(actor, { title: 'B', body: 'forged two', kind: 'memory', source: { system: 'supersede', externalId: 'b' } })).rejects.toBeInstanceOf(BrainInputError);
  });

  it('an owner supersede of a curated entry stays curated instead of folding into an episodic twin', async () => {
    const note = await store.note(actor, { title: 'Note', body: 'the shared body', kind: 'memory' });
    const { entry } = await store.note(actor, { title: 'Rule', body: 'deploy via CI only', kind: 'memory' });
    const curated = await store.promote(entry.slug, { standing: true });
    const owner = { agent: 'owner', originClass: 'owner' as const };
    const next = await store.supersede(owner, curated.slug, { body: 'the shared body', reason: 'align', expectedHash: curated.contentHash });
    expect(next.tier).toBe('curated');
    expect(next.slug).not.toBe(note.entry.slug);
    expect(await BrainEntry.countDocuments({ slug: note.entry.slug, live: true })).toBe(1);
    expect((await store.get(note.entry.slug))?.body).toBe('the shared body');
  });

  it('re-promoting the successor of an already-promoted entry keeps one live curated copy', async () => {
    const { entry } = await store.note(actor, { title: 'Rule', body: 'the first body', kind: 'memory' });
    const c1 = await store.promote(entry.slug, { standing: true });
    const hash = (await store.get(entry.slug))!.contentHash;
    const e2 = await store.supersede(actor, entry.slug, { body: 'the second body', reason: 'revise', expectedHash: hash });
    const c2 = await store.promote(e2.slug, { standing: true });
    expect(await BrainEntry.countDocuments({ tier: 'curated', live: true })).toBe(1);
    expect((await store.get(c2.slug))?.body).toBe('the second body');
    expect((await BrainEntry.findOne({ slug: c1.slug }))?.live).toBe(false);
  });

  it('re-promoting a re-imported source replaces the copy promoted from its earlier version', async () => {
    const source = { system: 'claude-memory', externalId: 'example/promoted.md' };
    const first = await store.note(actor, { title: 'Rule', body: 'the rule, version one', kind: 'memory', source });
    const c1 = await store.promote(first.entry.slug, { standing: true });
    const changed = await store.note(actor, { title: 'Rule', body: 'the rule, version two', kind: 'memory', source });
    expect(changed.created).toBe(true);
    const c2 = await store.promote(changed.entry.slug, { standing: true });
    expect(await BrainEntry.countDocuments({ tier: 'curated', live: true })).toBe(1);
    expect((await store.get(c2.slug))?.body).toBe('the rule, version two');
    expect((await store.get(c1.slug))?.supersededBy).toBe(c2.slug);
    // So does promoting an agent's correction of that re-import: still one live curated copy, now the correction's.
    const corrected = await store.supersede(actor, changed.entry.slug, { body: 'the rule, version two, corrected', reason: 'fix', expectedHash: changed.entry.contentHash });
    const c3 = await store.promote(corrected.slug, { standing: true });
    expect(await BrainEntry.countDocuments({ tier: 'curated', live: true })).toBe(1);
    expect((await store.get(c3.slug))?.body).toBe('the rule, version two, corrected');
    expect(index.fts('"version one"', { scopes: ['core'], tier: 'curated' }, 5)).toHaveLength(0);
  });

  it('an unchanged re-import keeps an agent\'s correction current after the retired original was forgotten by slug', async () => {
    const source = { system: 'clippings', externalId: 'web/forgotten-root' };
    const imported = await store.note(actor, { title: 'Clip', body: 'clip original text', kind: 'doc', source });
    const corrected = await store.supersede(actor, imported.entry.slug, { body: 'clip text, corrected', reason: 'fix', expectedHash: imported.entry.contentHash });
    expect(await store.forget(actor, { slug: imported.entry.slug }, 'drop the original')).toEqual({ forgotten: 1 });
    const again = await store.note(actor, { title: 'Clip', body: 'clip original text', kind: 'doc', source });
    expect(again).toMatchObject({ created: false, entry: { slug: corrected.slug } });
    expect(await BrainEntry.countDocuments({ live: true })).toBe(1);
    expect(index.fts('"original"', { scopes: ['core'] }, 5)).toHaveLength(0);
    // A changed source still replaces the correction.
    const changed = await store.note(actor, { title: 'Clip', body: 'clip text, revised at the source', kind: 'doc', source });
    expect(changed.created).toBe(true);
    expect((await store.get(corrected.slug))?.supersededBy).toBe(changed.entry.slug);
    expect(await BrainEntry.countDocuments({ live: true })).toBe(1);
  });

  it('strips the store-owned tags from caller input so an agent cannot forge a standing entry', async () => {
    const { entry } = await store.note(actor, { title: 'T', body: 'a body', kind: 'memory', tags: ['standing', 'needs-review', 'real-tag'] });
    expect(entry.tags).toEqual(['real-tag']);
    const copy = await store.promote(entry.slug, { standing: false });
    expect(copy.tags).not.toContain('standing');
    expect(copy.tags).not.toContain('needs-review');
  });

  it('demotes a promoted copy when a same-source untrusted re-import lands during the promotion', async () => {
    const source = { system: 'clippings', externalId: 'web/19' };
    const imported = await store.note(actor, { title: 'Clip', body: 'clip nineteen', kind: 'doc', source });
    const untrusted = { agent: 'importer:ops', originClass: 'untrusted' as const };
    const realCreate = BrainEntry.create.bind(BrainEntry) as (...args: unknown[]) => Promise<unknown>;
    vi.spyOn(BrainEntry, 'create').mockImplementationOnce((async (...args: unknown[]) => {
      // A changed-body untrusted re-import retires the trusted source and creates an untrusted successor, before this copy is inserted.
      await store.note(untrusted, { title: 'Clip', body: 'clip nineteen, altered', kind: 'doc', source });
      return realCreate(...args);
    }) as never);
    const copy = await store.promote(imported.entry.slug, { standing: true });
    expect(copy.originClass).toBe('untrusted');
    expect(copy.tags).not.toContain('standing');
    expect(copy.tags).toContain('needs-review');
  });

  it('a failed replacement during re-promotion restores the old curated copy, never leaving two or none', async () => {
    const { entry } = await store.note(actor, { title: 'Rule', body: 'body one', kind: 'memory' });
    const c1 = await store.promote(entry.slug, { standing: true });
    const hash = (await store.get(entry.slug))!.contentHash;
    const e2 = await store.supersede(actor, entry.slug, { body: 'body two', reason: 'revise', expectedHash: hash });
    vi.spyOn(BrainEntry, 'create').mockRejectedValueOnce(new Error('mongo hiccup'));
    await expect(store.promote(e2.slug, { standing: true })).rejects.toThrow('mongo hiccup');
    expect((await BrainEntry.findOne({ slug: c1.slug }))?.live).toBe(true);
    expect(await BrainEntry.countDocuments({ tier: 'curated', live: true })).toBe(1);
  });

  it('repairs the retired curated copy\'s index row when a re-promotion failed on that copy\'s index write after creating its replacement', async () => {
    const { entry } = await store.note(actor, { title: 'Rule', body: 'body one', kind: 'memory' });
    const c1 = await store.promote(entry.slug, { standing: true });
    const hash = (await store.get(entry.slug))!.contentHash;
    const e2 = await store.supersede(actor, entry.slug, { body: 'body two', reason: 'revise', expectedHash: hash });
    // The replacement is created, then the retired copy's index write (the first upsert after the create) fails.
    vi.spyOn(index, 'upsertEntry').mockImplementationOnce(() => { throw new Error('sqlite busy'); });
    await expect(store.promote(e2.slug, { standing: true })).rejects.toThrow('sqlite busy');
    const retired = (await BrainEntry.findOne({ slug: c1.slug }))!;
    expect(retired.live).toBe(false);
    // Mongo retired it, but the index still holds the pre-retirement row, so the stale body reads as current curated content.
    expect(index.updatedAtOf(retired._id.toString())).not.toBe(retired.updatedAt.getTime());
    expect(index.fts('"body one"', { scopes: ['core'], tier: 'curated' }, 5)).toHaveLength(1);
    const again = await store.promote(e2.slug, { standing: true });
    expect((await store.get(again.slug))?.body).toBe('body two');
    const repaired = (await BrainEntry.findOne({ slug: c1.slug }))!;
    expect(index.updatedAtOf(repaired._id.toString())).toBe(repaired.updatedAt.getTime());
    expect(repaired.supersededBy?.toString()).toBe((await BrainEntry.findOne({ slug: again.slug }))!._id.toString());
    // The repaired row carries its invalidAt, so the stale body no longer reads as a current curated fact.
    expect(index.fts('"body one"', { scopes: ['core'], tier: 'curated' }, 5)).toHaveLength(0);
    expect(await BrainEntry.countDocuments({ tier: 'curated', live: true })).toBe(1);
  });

  it('links a retired curated copy to its successor on retry when the re-promotion failed before saving that link', async () => {
    const { entry } = await store.note(actor, { title: 'Rule', body: 'body one', kind: 'memory' });
    const c1 = await store.promote(entry.slug, { standing: true });
    const hash = (await store.get(entry.slug))!.contentHash;
    const e2 = await store.supersede(actor, entry.slug, { body: 'body two', reason: 'revise', expectedHash: hash });
    // The replacement exists; the first save of a retired curated document is the old copy's link save, and it fails.
    const realSave = BrainEntry.prototype.save;
    let failed = false;
    vi.spyOn(BrainEntry.prototype, 'save').mockImplementation(async function (this: InstanceType<typeof BrainEntry>, ...args: unknown[]) {
      if (!failed && !this.isNew && this.tier === 'curated' && !this.live) {
        failed = true;
        throw new Error('mongo down');
      }
      return realSave.apply(this, args as never);
    } as never);
    await expect(store.promote(e2.slug, { standing: true })).rejects.toThrow('mongo down');
    const retired = (await BrainEntry.findOne({ slug: c1.slug }))!;
    expect(retired.live).toBe(false);
    expect(retired.supersededBy).toBeUndefined();
    const again = await store.promote(e2.slug, { standing: true });
    expect((await store.get(again.slug))?.body).toBe('body two');
    const repaired = (await BrainEntry.findOne({ slug: c1.slug }))!;
    expect(repaired.supersededBy?.toString()).toBe((await BrainEntry.findOne({ slug: again.slug }))!._id.toString());
    expect(index.updatedAtOf(repaired._id.toString())).toBe(repaired.updatedAt.getTime());
    expect(index.fts('"body one"', { scopes: ['core'], tier: 'curated' }, 5)).toHaveLength(0);
    expect(await BrainEntry.countDocuments({ tier: 'curated', live: true })).toBe(1);
  });

  it('a re-promotion whose insert loses to a concurrent promote keeps its retired copy retired and converges on the winner', async () => {
    const { entry } = await store.note(actor, { title: 'Rule', body: 'body one', kind: 'memory' });
    const c1 = await store.promote(entry.slug, { standing: true });
    const hash = (await store.get(entry.slug))!.contentHash;
    const e2 = await store.supersede(actor, entry.slug, { body: 'body two', reason: 'revise', expectedHash: hash });
    // Between this caller's retirement of c1 and its own insert, a concurrent promote inserts the replacement: the row
    // lands for the other caller and this one sees the promote identity's duplicate key. Restoring c1 would leave two live copies.
    const realCreate = BrainEntry.create.bind(BrainEntry) as unknown as (...args: unknown[]) => Promise<unknown>;
    vi.spyOn(BrainEntry, 'create').mockImplementationOnce((async (...args: unknown[]) => {
      await realCreate(...args);
      throw Object.assign(new Error('E11000 duplicate key'), { code: 11000, keyPattern: { 'source.externalId': 1 } });
    }) as never);
    const result = await store.promote(e2.slug, { standing: true });
    expect((await store.get(result.slug))?.body).toBe('body two');
    expect(await BrainEntry.countDocuments({ tier: 'curated', live: true })).toBe(1);
    const retired = (await BrainEntry.findOne({ slug: c1.slug }))!;
    expect(retired.live).toBe(false);
    expect(retired.supersededBy?.toString()).toBe((await BrainEntry.findOne({ slug: result.slug }))!._id.toString());
    expect(index.updatedAtOf(retired._id.toString())).toBe(retired.updatedAt.getTime());
    expect(index.fts('"body one"', { scopes: ['core'], tier: 'curated' }, 5)).toHaveLength(0);
    // Idempotent afterwards: a later promote converges on the same copy, never a conflict or a second live copy.
    expect((await store.promote(e2.slug, { standing: true })).slug).toBe(result.slug);
    expect(await BrainEntry.countDocuments({ tier: 'curated', live: true })).toBe(1);
  });

  it('links and re-indexes a copy another caller retired when this caller then creates the first live copy', async () => {
    const { entry } = await store.note(actor, { title: 'Rule', body: 'body one', kind: 'memory' });
    const c1 = await store.promote(entry.slug, { standing: true });
    const hash = (await store.get(entry.slug))!.contentHash;
    const e2 = await store.supersede(actor, entry.slug, { body: 'body two', reason: 'revise', expectedHash: hash });
    // The retirement lands but this caller is told it lost the race: it re-resolves into a lineage with no live copy.
    const realUpdate = BrainEntry.findOneAndUpdate.bind(BrainEntry) as unknown as (...args: unknown[]) => Promise<unknown>;
    vi.spyOn(BrainEntry, 'findOneAndUpdate').mockImplementationOnce((async (...args: unknown[]) => { await realUpdate(...args); return null; }) as never);
    const result = await store.promote(e2.slug, { standing: true });
    expect((await store.get(result.slug))?.body).toBe('body two');
    const retired = (await BrainEntry.findOne({ slug: c1.slug }))!;
    expect(retired.live).toBe(false);
    expect(retired.supersededBy?.toString()).toBe((await BrainEntry.findOne({ slug: result.slug }))!._id.toString());
    expect(index.updatedAtOf(retired._id.toString())).toBe(retired.updatedAt.getTime());
    expect(index.fts('"body one"', { scopes: ['core'], tier: 'curated' }, 5)).toHaveLength(0);
    expect(await BrainEntry.countDocuments({ tier: 'curated', live: true })).toBe(1);
  });

  it('re-resolves instead of indexing a stale copy when an owner supersede of that copy lands during its in-step update', async () => {
    const { entry } = await store.note(actor, { title: 'Rule', body: 'the rule as first written', kind: 'memory' });
    const c1 = await store.promote(entry.slug, { standing: false });
    const owner = { agent: 'owner', originClass: 'owner' as const };
    // Adding the standing tag is the in-step compare-and-set; the owner's supersede of that same copy lands just before it.
    const realUpdate = BrainEntry.findOneAndUpdate.bind(BrainEntry) as unknown as (...args: unknown[]) => Promise<unknown>;
    vi.spyOn(BrainEntry, 'findOneAndUpdate').mockImplementationOnce((async (...args: unknown[]) => {
      await store.supersede(owner, c1.slug, { body: 'the rule, corrected by the owner', reason: 'fix', expectedHash: c1.contentHash });
      return realUpdate(...args);
    }) as never);
    const result = await store.promote(entry.slug, { standing: true });
    // The successor, not the retired snapshot, is what gets brought in step and returned.
    expect((await store.get(result.slug))?.body).toBe('the rule, corrected by the owner');
    expect(result.tags).toContain('standing');
    const retired = (await BrainEntry.findOne({ slug: c1.slug }))!;
    expect(retired.live).toBe(false);
    // The retired copy's row was never overwritten with a current-looking snapshot.
    expect(index.updatedAtOf(retired._id.toString())).toBe(retired.updatedAt.getTime());
    expect(index.fts('"first written"', { scopes: ['core'], tier: 'curated' }, 5)).toHaveLength(0);
    expect(await BrainEntry.countDocuments({ tier: 'curated', live: true })).toBe(1);
  });

  it('recovers when it loses the retirement race during re-promotion, converging to one live curated copy', async () => {
    const { entry } = await store.note(actor, { title: 'Rule', body: 'body one', kind: 'memory' });
    await store.promote(entry.slug, { standing: true });
    const hash = (await store.get(entry.slug))!.contentHash;
    const e2 = await store.supersede(actor, entry.slug, { body: 'body two', reason: 'revise', expectedHash: hash });
    // Simulate losing the retirement compare-and-set once (a concurrent re-promotion won it): the loop must re-resolve, not create a duplicate.
    vi.spyOn(BrainEntry, 'findOneAndUpdate').mockResolvedValueOnce(null as never);
    const result = await store.promote(e2.slug, { standing: true });
    expect(await BrainEntry.countDocuments({ tier: 'curated', live: true })).toBe(1);
    expect((await store.get(result.slug))?.body).toBe('body two');
  });

  it('agent deduplication never resolves to, or moves, a curated entry', async () => {
    const later = new Date(Date.now() + 7 * 86_400_000);
    const { entry } = await store.note(actor, { title: 'Rule', body: 'a standing rule scheduled ahead', kind: 'memory', validFrom: later });
    const copy = await store.promote(entry.slug, { standing: true });
    await store.supersede(actor, entry.slug, { body: 'the episodic source moved on', reason: 'edit', expectedHash: entry.contentHash });
    const again = await store.note(actor, { title: 'Rule', body: 'a standing rule scheduled ahead', kind: 'memory' });
    expect(again.created).toBe(true);
    expect(again.entry.tier).toBe('episodic');
    expect((await BrainEntry.findOne({ slug: copy.slug }))?.validFrom.getTime()).toBe(later.getTime());
  });

  it('folding or deduping onto a twin scheduled for later makes the twin current from that instant', async () => {
    const later = new Date(Date.now() + 7 * 86_400_000);
    const scheduled = await store.note(actor, { title: 'Soon', body: 'the office moves to floor 4', kind: 'memory', validFrom: later });
    const current = await store.note(actor, { title: 'Now', body: 'the office is on floor 2', kind: 'memory' });
    expect(index.fts('"floor 4"', { scopes: ['core'] }, 5)).toHaveLength(0);
    const merged = await store.supersede(actor, current.entry.slug, { body: 'the office moves to floor 4', reason: 'moved early', expectedHash: current.entry.contentHash });
    expect(merged.slug).toBe(scheduled.entry.slug);
    const twin = await BrainEntry.findOne({ slug: scheduled.entry.slug });
    const old = await BrainEntry.findOne({ slug: current.entry.slug });
    expect(twin?.validFrom.getTime()).toBe(old?.invalidAt?.getTime());
    expect(twin!.validFrom.getTime()).toBeLessThanOrEqual(Date.now());
    expect(index.fts('"floor 4"', { scopes: ['core'] }, 5)).toHaveLength(1);
    const early = await store.note(actor, { title: 'Ahead', body: 'a fact scheduled for later', kind: 'memory', validFrom: later });
    const now = await store.note(actor, { title: 'Ahead', body: 'a fact scheduled for later', kind: 'memory' });
    expect(now.created).toBe(false);
    expect((await BrainEntry.findOne({ slug: early.entry.slug }))!.validFrom.getTime()).toBeLessThanOrEqual(Date.now());
    expect(index.fts('"scheduled"', { scopes: ['core'] }, 5)).toHaveLength(1);
  });

  it('puts the current version back when the replacement cannot be created', async () => {
    const { entry } = await store.note(actor, { title: 'Fact', body: 'the fact as it stands', kind: 'memory' });
    vi.spyOn(BrainEntry, 'create').mockRejectedValueOnce(new Error('mongo hiccup'));
    await expect(store.supersede(actor, entry.slug, { body: 'the fact, revised', reason: 'update', expectedHash: entry.contentHash })).rejects.toThrow('mongo hiccup');
    expect(await store.get(entry.slug)).toMatchObject({ invalidAt: null, supersededBy: null });
    expect((await BrainEntry.findOne({ slug: entry.slug }))?.live).toBe(true);
    const next = await store.supersede(actor, entry.slug, { body: 'the fact, revised', reason: 'update', expectedHash: entry.contentHash });
    expect((await store.get(entry.slug))?.supersededBy).toBe(next.slug);
  });

  it('dates a changed re-import by its capture time', async () => {
    const source = { system: 'claude-memory', externalId: 'example/dated.md' };
    const t1 = new Date('2026-01-01T00:00:00Z');
    const t2 = new Date('2026-02-01T00:00:00Z');
    const first = await store.note(actor, { title: 'Dated', body: 'version one', kind: 'memory', source, validFrom: t1 });
    expect(first.entry.validFrom).toBe(t1.toISOString());
    const second = await store.note(actor, { title: 'Dated', body: 'version two', kind: 'memory', source, validFrom: t2 });
    expect(second.entry.validFrom).toBe(t2.toISOString());
    expect((await store.get(first.entry.slug))?.invalidAt).toBe(t2.toISOString());
    // A capture time that is not after the current version falls back to now.
    const third = await store.note(actor, { title: 'Dated', body: 'version three', kind: 'memory', source, validFrom: t1 });
    expect(new Date(third.entry.validFrom).getTime()).toBeGreaterThan(t2.getTime());
  });

  it('folds a supersede or re-import whose body already exists into that live entry', async () => {
    const a = await store.note(actor, { title: 'A', body: 'shared truth', kind: 'memory' });
    const b = await store.note(actor, { title: 'B', body: 'different text', kind: 'memory' });
    const aId = (await BrainEntry.findOne({ slug: a.entry.slug }))!._id.toString();
    index.removeEntry(aId); // an earlier write left the twin without an index row
    const merged = await store.supersede(actor, b.entry.slug, { body: 'shared truth', reason: 'same fact', expectedHash: b.entry.contentHash });
    expect(merged.slug).toBe(a.entry.slug);
    expect(index.hasEntry(aId)).toBe(true);
    expect((await store.get(b.entry.slug))?.supersededBy).toBe(a.entry.slug);
    expect((await store.get(a.entry.slug))?.history.map((h) => h.slug)).toEqual([b.entry.slug]);
    expect(index.fts('"different"', { scopes: ['core'] }, 5)).toHaveLength(0);
    const source = { system: 'claude-memory', externalId: 'example/c.md' };
    const c = await store.note(actor, { title: 'C', body: 'c version one', kind: 'memory', source });
    const again = await store.note(actor, { title: 'C', body: 'shared truth', kind: 'memory', source });
    expect(again.created).toBe(false);
    expect(again.entry.slug).toBe(a.entry.slug);
    expect((await store.get(c.entry.slug))?.supersededBy).toBe(a.entry.slug);
    expect(await BrainEntry.countDocuments({ live: true })).toBe(1);
  });

  it('folds in one write, and puts the entry back when a raced fold link cannot be saved', async () => {
    const twin = await store.note(actor, { title: 'Twin', body: 'the shared fold body', kind: 'memory' });
    const a = await store.note(actor, { title: 'A', body: 'body a', kind: 'memory' });
    const create = vi.spyOn(BrainEntry, 'create');
    const merged = await store.supersede(actor, a.entry.slug, { body: 'the shared fold body', reason: 'same', expectedHash: a.entry.contentHash });
    expect(merged.slug).toBe(twin.entry.slug);
    expect(create).not.toHaveBeenCalled();
    expect((await store.get(a.entry.slug))?.supersededBy).toBe(twin.entry.slug);

    // A twin that appears between the pre-check and the insert is found through the duplicate key; when the
    // link then cannot be saved, the retirement is undone and the retry folds up front.
    const b = await store.note(actor, { title: 'B', body: 'body b', kind: 'memory' });
    const raced = 'the body that races in';
    create.mockImplementationOnce(async () => {
      await store.note(actor, { title: 'Racer', body: raced, kind: 'memory' });
      vi.spyOn(BrainEntry.prototype, 'save').mockRejectedValueOnce(new Error('link save failed'));
      throw Object.assign(new Error('E11000 duplicate key'), { code: 11000, keyPattern: { namespace: 1, contentHash: 1 } });
    });
    await expect(store.supersede(actor, b.entry.slug, { body: raced, reason: 'race', expectedHash: b.entry.contentHash })).rejects.toThrow('link save failed');
    expect(await store.get(b.entry.slug)).toMatchObject({ invalidAt: null, supersededBy: null });
    const retried = await store.supersede(actor, b.entry.slug, { body: raced, reason: 'race', expectedHash: b.entry.contentHash });
    expect((await store.get(b.entry.slug))?.supersededBy).toBe(retried.slug);
    expect(await BrainEntry.countDocuments({ contentHash: retried.contentHash, live: true })).toBe(1);
  });

  it('lets only one of two concurrent supersedes retire the entry', async () => {
    const { entry } = await store.note(actor, { title: 'Fact', body: 'the current fact', kind: 'memory' });
    const results = await Promise.allSettled([
      store.supersede(actor, entry.slug, { body: 'revision one', reason: 'r1', expectedHash: entry.contentHash }),
      store.supersede(actor, entry.slug, { body: 'revision two', reason: 'r2', expectedHash: entry.contentHash }),
    ]);
    const won = results.filter((r): r is PromiseFulfilledResult<BrainEntryView> => r.status === 'fulfilled');
    const lost = results.filter((r): r is PromiseRejectedResult => r.status === 'rejected');
    expect(won).toHaveLength(1);
    expect(lost).toHaveLength(1);
    expect(lost[0].reason instanceof BrainConflictError || lost[0].reason instanceof BrainInputError).toBe(true);
    expect(await BrainEntry.countDocuments({ live: true })).toBe(1);
    expect((await store.get(entry.slug))?.supersededBy).toBe(won[0].value.slug);
  });

  it('repairs both versions when a replacement is retried after its index write failed', async () => {
    const { entry } = await store.note(actor, { title: 'Fact', body: 'before the change', kind: 'memory' });
    vi.spyOn(index, 'upsertEntry').mockImplementationOnce(() => {
      throw new Error('sqlite busy');
    });
    await expect(store.supersede(actor, entry.slug, { body: 'after the change', reason: 'edit', expectedHash: entry.contentHash })).rejects.toThrow('sqlite busy');
    const next = await BrainEntry.findOne({ live: true });
    expect(next?.body).toBe('after the change');
    expect(index.hasEntry(next!._id.toString())).toBe(false);
    expect(index.fts('"before"', { scopes: ['core'] }, 5)).toHaveLength(1);
    await expect(store.supersede(actor, entry.slug, { body: 'again', reason: 'retry', expectedHash: entry.contentHash })).rejects.toBeInstanceOf(BrainInputError);
    expect(index.hasEntry(next!._id.toString())).toBe(true);
    expect(index.fts('"before"', { scopes: ['core'] }, 5)).toHaveLength(0);
    expect(index.fts('"after"', { scopes: ['core'] }, 5)).toHaveLength(1);
  });

  it('recovers and links the successor when the link itself was never saved', async () => {
    const { entry } = await store.note(actor, { title: 'Fact', body: 'link will fail', kind: 'memory' });
    const original = BrainEntry.prototype.save;
    const spy = vi.spyOn(BrainEntry.prototype, 'save').mockImplementation(function (this: IBrainEntryDocument, ...args: unknown[]) {
      if (!this.isNew && this.supersededBy) {
        spy.mockRestore();
        return Promise.reject(new Error('mongo hiccup'));
      }
      return original.apply(this, args as never);
    });
    await expect(store.supersede(actor, entry.slug, { body: 'the successor', reason: 'edit', expectedHash: entry.contentHash })).rejects.toThrow('mongo hiccup');
    const successor = await BrainEntry.findOne({ live: true });
    expect(successor?.body).toBe('the successor');
    expect((await BrainEntry.findOne({ slug: entry.slug }))?.supersededBy).toBeUndefined();
    expect(index.hasEntry(successor!._id.toString())).toBe(false);
    await expect(store.supersede(actor, entry.slug, { body: 'again', reason: 'retry', expectedHash: entry.contentHash })).rejects.toBeInstanceOf(BrainInputError);
    expect((await store.get(entry.slug))?.supersededBy).toBe(successor!.slug);
    expect(index.hasEntry(successor!._id.toString())).toBe(true);
    expect(index.fts('"successor"', { scopes: ['core'] }, 5)).toHaveLength(1);
  });

  it('agents cannot forget curated entries; the owner can', async () => {
    const { entry } = await store.note(actor, { title: 'Rule', body: 'The owner prefers bun.', kind: 'memory' });
    const curated = await store.promote(entry.slug, { standing: true });
    await expect(store.forget(actor, { slug: curated.slug }, 'nope')).rejects.toBeInstanceOf(BrainInputError);
    const owner = { agent: 'owner', originClass: 'owner' as const };
    // The lineage labels are not import systems: neither actor can sweep "every promote" (the whole curated tier) or
    // "every supersede" through a source selector, whichever form it takes.
    await expect(store.forget(actor, { wholeSource: { system: 'promote' } }, 'sweep')).rejects.toBeInstanceOf(BrainInputError);
    await expect(store.forget(owner, { wholeSource: { system: 'promote' } }, 'sweep')).rejects.toBeInstanceOf(BrainInputError);
    await expect(store.forget(owner, { wholeSource: { system: 'supersede' } }, 'sweep')).rejects.toBeInstanceOf(BrainInputError);
    await expect(store.forget(owner, { source: { system: 'promote', externalId: entry.slug } }, 'sweep')).rejects.toBeInstanceOf(BrainInputError);
    expect(await store.get(curated.slug)).not.toBeNull();
    expect(await store.forget(owner, { slug: curated.slug }, 'retired')).toEqual({ forgotten: 1 });
    expect(await store.get(curated.slug)).toBeNull();
  });

  it('agents cannot supersede curated entries; the owner can', async () => {
    const { entry } = await store.note(actor, { title: 'Rule', body: 'The owner prefers pnpm.', kind: 'memory' });
    const curated = await store.promote(entry.slug, { standing: false });
    await expect(store.supersede(actor, curated.slug, { body: 'The owner prefers npm.', reason: 'nope', expectedHash: curated.contentHash })).rejects.toBeInstanceOf(BrainInputError);
    const owner = { agent: 'owner', originClass: 'owner' as const };
    const next = await store.supersede(owner, curated.slug, { body: 'The owner prefers bun.', reason: 'tooling moved', expectedHash: curated.contentHash });
    expect(next.tier).toBe('curated');
  });

  it('repairs the index when a dedupe hit is missing from it', async () => {
    const { entry } = await store.note(actor, { title: 'A', body: 'alpha repair', kind: 'memory' });
    const doc = await BrainEntry.findOne({ slug: entry.slug });
    index.removeEntry(doc!._id.toString());
    expect(index.counts().entries).toBe(0);
    const again = await store.note(actor, { title: 'A2', body: 'alpha repair', kind: 'memory' });
    expect(again.created).toBe(false);
    expect(index.counts().entries).toBe(1);
  });

  it('does not fold a source into a twin that was forgotten in the read-to-retire gap; it restores the source and conflicts', async () => {
    const own = await store.note(actor, { title: 'Own', body: 'a shared body', kind: 'memory' });
    const source = { system: 'clippings', externalId: 'web/fold-race' };
    const head = await store.note(actor, { title: 'Clip', body: 'clip original', kind: 'doc', source });
    // The re-import's changed body matches `own`; forget `own` in the gap between the twin read and the retire.
    const realUpdate = BrainEntry.findOneAndUpdate.bind(BrainEntry) as unknown as (...args: unknown[]) => Promise<unknown>;
    vi.spyOn(BrainEntry, 'findOneAndUpdate').mockImplementationOnce((async (...args: unknown[]) => {
      await BrainEntry.updateOne({ slug: own.entry.slug }, { $set: { live: false, forgotten: { at: new Date(), reason: 'race', by: 'someone' } } });
      return realUpdate(...args);
    }) as never);
    await expect(store.note(actor, { title: 'Clip', body: 'a shared body', kind: 'doc', source })).rejects.toBeInstanceOf(BrainConflictError);
    // The import head stays live rather than being folded into the forgotten twin, so the lineage keeps a live version.
    const stillHead = (await BrainEntry.findOne({ slug: head.entry.slug }))!;
    expect(stillHead.live).toBe(true);
    expect(stillHead.supersededBy).toBeUndefined();
    expect((await store.get(head.entry.slug))?.body).toBe('clip original');
    expect(await BrainEntry.countDocuments({ 'source.externalId': 'web/fold-race', live: true })).toBe(1);
  });

  it('a source-based forget reaches a live correction past an individually-forgotten intermediate version', async () => {
    const source = { system: 'clippings', externalId: 'web/chain' };
    const a = await store.note(actor, { title: 'A', body: 'chain version a', kind: 'doc', source });
    const b = await store.supersede(actor, a.entry.slug, { body: 'chain version b', reason: 'fix', expectedHash: a.entry.contentHash });
    const c = await store.supersede(actor, b.slug, { body: 'chain version c', reason: 'fix again', expectedHash: b.contentHash });
    // Forget the already-retired intermediate B by slug; C stays live.
    expect(await store.forget(actor, { slug: b.slug }, 'drop the intermediate')).toEqual({ forgotten: 1 });
    expect(await store.get(c.slug)).not.toBeNull();
    // A whole-source forget of the identity must still reach C past the forgotten B (A and C retired, B already gone).
    expect(await store.forget(actor, { wholeSource: { system: 'clippings' } }, 'source withdrawn')).toEqual({ forgotten: 2 });
    expect(await store.get(c.slug)).toBeNull();
    expect(index.fts('"version c"', { scopes: ['core'] }, 5)).toHaveLength(0);
  });

  it('demotes a promoted copy when a racing untrusted re-import folds the whole import lineage away before the copy exists', async () => {
    const source = { system: 'clippings', externalId: 'web/no-head' };
    const own = await store.note(actor, { title: 'Own', body: 'a body the import will fold into', kind: 'memory' });
    const imported = await store.note(actor, { title: 'Clip', body: 'clip body original', kind: 'doc', source });
    expect(own.entry.slug).not.toBe(imported.entry.slug);
    const realCreate = BrainEntry.create.bind(BrainEntry) as unknown as (...a: unknown[]) => Promise<unknown>;
    vi.spyOn(BrainEntry, 'create').mockImplementationOnce((async (...a: unknown[]) => {
      // An untrusted re-import changes the body to the twin's, folding the whole import lineage into `own`
      // (so the import has no live head) and demoting dependents BEFORE this curated copy exists — so only
      // settleCopy's missing-head check can keep the copy from staying trusted and standing.
      await store.note({ agent: 'importer:ops', originClass: 'untrusted' as const }, { title: 'Clip', body: 'a body the import will fold into', kind: 'doc', source });
      return realCreate(...a);
    }) as never);
    const promoted = await store.promote(imported.entry.slug, { standing: true });
    const copyDoc = (await BrainEntry.findOne({ slug: promoted.slug }))!;
    expect(copyDoc.originClass).toBe('untrusted');
    expect(copyDoc.tags).not.toContain('standing');
    expect(copyDoc.tags).toContain('needs-review');
  });

  it('undoes a fold when the twin is forgotten during the fold\'s writes, keeping the lineage with a live version', async () => {
    const own = await store.note(actor, { title: 'Own', body: 'a second shared body', kind: 'memory' });
    const source = { system: 'clippings', externalId: 'web/fold-race-2' };
    const head = await store.note(actor, { title: 'Clip', body: 'clip two original', kind: 'doc', source });
    // The twin passes the post-retire re-read but is forgotten before the fold's final check; simulate that by having
    // the final existence check (the only BrainEntry.exists caller) report the twin gone once.
    vi.spyOn(BrainEntry, 'exists').mockResolvedValueOnce(null);
    await expect(store.note(actor, { title: 'Clip', body: 'a second shared body', kind: 'doc', source })).rejects.toBeInstanceOf(BrainConflictError);
    vi.restoreAllMocks();
    const stillHead = (await BrainEntry.findOne({ slug: head.entry.slug }))!;
    expect(stillHead.live).toBe(true);
    expect(stillHead.supersededBy).toBeUndefined();
    expect((await store.get(head.entry.slug))?.body).toBe('clip two original');
    // The fold was undone, so the twin is left exactly as it was, still live.
    expect((await store.get(own.entry.slug))?.body).toBe('a second shared body');
  });

  it('indexes the document as stored, not the caller\'s snapshot, when a partial save follows a concurrent retirement', async () => {
    const { entry } = await store.note(actor, { title: 'Rule', body: 'snapshot hazard body', kind: 'memory' });
    const copy = await store.promote(entry.slug, { standing: false });
    const snapshot = (await BrainEntry.findOne({ slug: copy.slug }))!;
    // Another writer retires the copy; this writer then saves only its tags from a snapshot that still says live.
    const at = new Date();
    await BrainEntry.findOneAndUpdate({ _id: snapshot._id, live: true }, { $set: { live: false, invalidAt: at, expiredAt: at } });
    snapshot.tags = ['reviewed'];
    await snapshot.save();
    expect(snapshot.live).toBe(true);
    await store.indexEntry(snapshot);
    const stored = (await BrainEntry.findOne({ slug: copy.slug }))!;
    expect(stored.live).toBe(false);
    expect(index.updatedAtOf(stored._id.toString())).toBe(stored.updatedAt.getTime());
    // The row carries Mongo's invalidAt, so the retired copy is not served as a current curated fact.
    expect(index.fts('"hazard"', { scopes: ['core'], tier: 'curated' }, 5)).toHaveLength(0);
    expect(index.fts('"hazard"', { scopes: ['core'], tier: 'curated', includeSuperseded: true }, 5)).toHaveLength(1);
  });

  it('indexes a chunk too large to split, embedding only its opening, so a provider input limit cannot keep it out', async () => {
    const embedder = createFakeEmbedder(32);
    const real = embedder.embedDocuments.bind(embedder);
    vi.spyOn(embedder, 'embedDocuments').mockImplementation(async (inputs) => {
      if (inputs.some((input) => input.length > 8_000)) {
        throw new Error('OpenAI-compatible embedding request failed with 400: input too long');
      }
      return real(inputs);
    });
    const limited = new BrainStore({ index, embedder, config });
    const fence = ['```json', ...Array.from({ length: 2_000 }, (_, i) => `  "field_${i}": ${i},`), '  "closing_marker": true', '```'].join('\n');
    expect(fence.length).toBeGreaterThan(30_000);
    const { entry } = await limited.note(actor, { title: 'Big fence', body: fence, kind: 'doc' });
    const doc = (await BrainEntry.findOne({ slug: entry.slug }))!;
    expect(index.hasEntry(doc._id.toString())).toBe(true);
    // The keyword index holds the whole block; the vector covers its opening.
    expect(index.fts('"closing_marker"', { scopes: ['core'] }, 5)).toHaveLength(1);
    expect(index.knn(await embedder.embedQuery(embedder.queryInput('field_1')), { scopes: ['core'] }, 5)).toHaveLength(1);
  });

  it('retires the parts an import item no longer has, whichever way it crosses the size limit', async () => {
    const system = 'openclaw-workspace';
    const importer = { agent: 'importer:ops', originClass: 'agent' as const };
    const put = async (externalId: string, body: string, parts?: number): Promise<number> => {
      await store.note(importer, { title: externalId, body, kind: 'memory', source: { system, externalId } });
      return store.retireObsoleteParts(importer, { system, externalId }, parts);
    };
    const live = async (): Promise<string[]> => (await BrainEntry.find({ 'source.system': system, live: true }).lean()).map((e) => e.source?.externalId ?? '').sort();
    // A whole item grows past the limit: its first part retires the whole-item identity.
    await put('day.md', 'the day, short');
    expect(await put('day.md#part-1', 'the day, part one', 3)).toBe(1);
    await put('day.md#part-2', 'the day, part two', 3);
    await put('day.md#part-3', 'the day, part three', 3);
    expect(await live()).toEqual(['day.md#part-1', 'day.md#part-2', 'day.md#part-3']);
    // It shrinks to two parts after an agent corrected the third: the third goes, its correction with it.
    const third = (await BrainEntry.findOne({ 'source.externalId': 'day.md#part-3' }))!;
    await store.supersede(actor, third.slug, { body: 'the day, part three, corrected', reason: 'fix', expectedHash: third.contentHash });
    expect(await put('day.md#part-1', 'the day, part one', 2)).toBe(2);
    expect(await put('day.md#part-2', 'the day, part two', 2)).toBe(0);
    expect(await live()).toEqual(['day.md#part-1', 'day.md#part-2']);
    expect(index.fts('"corrected"', { scopes: ['core'] }, 5)).toHaveLength(0);
    // It shrinks back under the limit: the whole item retires every part.
    expect(await put('day.md', 'the day, short again')).toBe(2);
    expect(await live()).toEqual(['day.md']);
    // A whole item whose own id ends like a part is not one, but a real part of it still retires it.
    expect(await put('notes#part-2', 'a file named like a part')).toBe(0);
    expect(await put('notes#part-2#part-1', 'that file, grown, part one', 2)).toBe(1);
    await expect(store.retireObsoleteParts(importer, { system, externalId: 'day.md' }, 2)).rejects.toBeInstanceOf(BrainInputError);
    await expect(store.retireObsoleteParts(importer, { system, externalId: 'day.md#part-3' }, 2)).rejects.toBeInstanceOf(BrainInputError);
  });

  it('retires the correction of a part whose retired original was forgotten by slug, when the item no longer has it', async () => {
    const system = 'openclaw-workspace';
    const importer = { agent: 'importer:ops', originClass: 'agent' as const };
    const put = async (externalId: string, body: string, parts?: number): Promise<number> => {
      await store.note(importer, { title: externalId, body, kind: 'memory', source: { system, externalId } });
      return store.retireObsoleteParts(importer, { system, externalId }, parts);
    };
    await put('week.md#part-1', 'the week, part one', 2);
    await put('week.md#part-2', 'the week, part two', 2);
    const second = (await BrainEntry.findOne({ 'source.externalId': 'week.md#part-2' }))!;
    const corrected = await store.supersede(actor, second.slug, { body: 'the week, part two, corrected', reason: 'fix', expectedHash: second.contentHash });
    // The retired original is forgotten by slug; its correction is still the part's current text.
    expect(await store.forget(actor, { slug: second.slug }, 'tidy')).toEqual({ forgotten: 1 });
    expect(await store.get(corrected.slug)).not.toBeNull();
    // The item fits in one entry again: every part goes, the second one's correction with it.
    expect(await put('week.md', 'the week, short')).toBe(2);
    expect(await store.get(corrected.slug)).toBeNull();
    expect(index.fts('"corrected"', { scopes: ['core'] }, 5)).toHaveLength(0);
  });

  it('lists every version folded into an entry in its history, nearest first and newest retirement first', async () => {
    const twin = await store.note(actor, { title: 'Port', body: 'the port is 4310', kind: 'memory' });
    const a = await store.note(actor, { title: 'Old A', body: 'the port is 4300', kind: 'memory' });
    const b = await store.note(actor, { title: 'Old B', body: 'the port might be 4305', kind: 'memory' });
    const older = await store.supersede(actor, a.entry.slug, { body: 'the port is probably 4300', reason: 'hedge', expectedHash: a.entry.contentHash });
    // Two different entries corrected to the twin's body both fold into it, so it has two predecessors.
    await store.supersede(actor, older.slug, { body: 'the port is 4310', reason: 'moved', expectedHash: older.contentHash });
    await store.supersede(actor, b.entry.slug, { body: 'the port is 4310', reason: 'moved', expectedHash: b.entry.contentHash });
    expect((await store.get(twin.entry.slug))?.history.map((h) => h.slug)).toEqual([b.entry.slug, older.slug, a.entry.slug]);
  });

  it('windows long bodies on get', async () => {
    const body = 'x'.repeat(9000);
    const { entry } = await store.note(actor, { title: 'Long', body, kind: 'doc' });
    const first = await store.get(entry.slug);
    expect(first?.body.length).toBe(8000);
    expect(first?.hasMore).toBe(true);
    const rest = await store.get(entry.slug, 8000);
    expect(rest?.body.length).toBe(1000);
    expect(rest?.hasMore).toBe(false);
  });

  describe('namespace visibility', () => {
    const alpha = { namespaces: ['agent:alpha'] };
    const beta = { namespaces: ['agent:beta'] };

    it('dedupes identical bodies per namespace, so a note never resolves to an entry in another namespace', async () => {
      const a = await store.note(actor, { title: 'A', body: 'the same sentence', kind: 'memory', namespace: 'agent:alpha' }, alpha);
      const b = await store.note(actor, { title: 'B', body: 'the same sentence', kind: 'memory', namespace: 'agent:beta' }, beta);
      expect([a.created, b.created]).toEqual([true, true]);
      expect(a.entry.slug).not.toBe(b.entry.slug);
      expect([a.entry.namespace, b.entry.namespace]).toEqual(['agent:alpha', 'agent:beta']);
      const again = await store.note(actor, { title: 'B again', body: 'the same sentence', kind: 'memory', namespace: 'agent:beta' }, beta);
      expect(again).toMatchObject({ created: false, entry: { slug: b.entry.slug } });
    });

    it('hides entries outside the caller\'s namespaces from get, list, supersede and forget, and refuses writes there', async () => {
      const { entry } = await store.note(actor, { title: 'Beta only', body: 'beta keeps this to itself', kind: 'memory', namespace: 'agent:beta' });
      expect(await store.get(entry.slug, 0, alpha)).toBeNull();
      expect(await store.get(entry.slug, 0, beta)).toMatchObject({ slug: entry.slug });
      expect((await store.list({}, { page: 1, limit: 10 }, alpha)).items).toEqual([]);
      expect((await store.list({ namespaces: ['agent:beta'] }, { page: 1, limit: 10 }, alpha)).items).toEqual([]);
      expect((await store.list({}, { page: 1, limit: 10 }, beta)).items.map((i) => i.slug)).toEqual([entry.slug]);
      await expect(store.supersede(actor, entry.slug, { body: 'rewritten by alpha', reason: 'r', expectedHash: entry.contentHash }, alpha)).rejects.toBeInstanceOf(BrainNotFoundError);
      expect(await store.forget(actor, { slug: entry.slug }, 'alpha tried', alpha)).toEqual({ forgotten: 0 });
      expect(await store.get(entry.slug)).toMatchObject({ body: 'beta keeps this to itself', invalidAt: null });
      await expect(store.note(actor, { title: 'Into beta', body: 'alpha writing into beta', kind: 'memory', namespace: 'agent:beta' }, alpha)).rejects.toThrow(/outside this key's namespaces/u);
      await expect(store.note(actor, { title: 'Default', body: 'no namespace given', kind: 'memory' }, alpha)).rejects.toThrow(/namespace shared is outside/u);
      expect(await BrainEntry.countDocuments({ namespace: 'agent:beta' })).toBe(1);
    });

    it('lets a confined caller forget by slug only, since an import identity can span namespaces', async () => {
      await store.note(actor, { title: 'Imported', body: 'imported into alpha', kind: 'doc', namespace: 'agent:alpha', source: { system: 'clippings', externalId: 'c/1' } });
      await expect(store.forget(actor, { source: { system: 'clippings', externalId: 'c/1' } }, 'x', alpha)).rejects.toThrow(/by slug/u);
      await expect(store.forget(actor, { wholeSource: { system: 'clippings' } }, 'x', alpha)).rejects.toThrow(/by slug/u);
      expect(await store.forget(actor, { source: { system: 'clippings', externalId: 'c/1' } }, 'unconfined')).toEqual({ forgotten: 1 });
    });

    it('names a successor and lists history only where the caller may see them', async () => {
      const source = { system: 'clippings', externalId: 'c/move' };
      const owner = { agent: 'importer:owner', originClass: 'owner' as const };
      const first = await store.note(owner, { title: 'Moving', body: 'first home', kind: 'doc', namespace: 'agent:alpha', source });
      const moved = await store.note(owner, { title: 'Moving', body: 'second home', kind: 'doc', namespace: 'agent:beta', source });
      expect(moved).toMatchObject({ created: true, entry: { namespace: 'agent:beta' } });
      expect((await store.get(first.entry.slug))?.supersededBy).toBe(moved.entry.slug);
      expect((await store.get(first.entry.slug, 0, alpha))?.supersededBy).toBeNull();
      expect((await store.get(moved.entry.slug))?.history.map((h) => h.slug)).toEqual([first.entry.slug]);
      expect((await store.get(moved.entry.slug, 0, beta))?.history).toEqual([]);
    });
  });
});
