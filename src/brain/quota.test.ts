import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { testConfig, testIdentity } from '../test-support/brain.js';
import { clearTestDb, setupTestDb, teardownTestDb } from '../test-support/mongo.js';
import { createFakeEmbedder } from './embeddings/index.js';
import { openBrainIndex } from './index/sqlite.js';
import { agentWriteUsage, withAgentWriteQuota } from './quota.js';
import { BrainInputError, BrainStore } from './store.js';

const config = testConfig();
const agent = { agent: 'codex@laptop', originClass: 'agent' as const };
const owner = { agent: 'importer:owner', originClass: 'owner' as const };

describe('agent write quota', () => {
  let store: BrainStore;

  beforeAll(setupTestDb);
  afterAll(teardownTestDb);
  beforeEach(async () => {
    await clearTestDb();
    store = new BrainStore({ index: openBrainIndex({ path: ':memory:', identity: testIdentity(config) }), embedder: createFakeEmbedder(32), config });
  });

  it('counts every version an agent wrote, history included, and never the owner\'s', async () => {
    const limited = withAgentWriteQuota(store, { maxEntries: 2, maxBytes: 10_000 });
    const first = await limited.note(agent, { title: 'One', body: 'first agent note', kind: 'memory' });
    await limited.supersede(agent, first.entry.slug, { body: 'first agent note, corrected', reason: 'fix', expectedHash: first.entry.contentHash });
    expect(await agentWriteUsage()).toMatchObject({ entries: 2 });
    await expect(limited.note(agent, { title: 'Three', body: 'over the entry cap', kind: 'memory' })).rejects.toBeInstanceOf(BrainInputError);
    expect((await limited.note(owner, { title: 'Owner', body: 'owner writes are not metered', kind: 'memory' })).created).toBe(true);
    await store.forget(agent, { slug: first.entry.slug }, 'forgetting frees nothing');
    await expect(limited.note(agent, { title: 'Still full', body: 'history still counts', kind: 'memory' })).rejects.toThrow(/allows agents is full/u);
  });

  it('counts only what agent keys write: imports and promoted copies with the agent origin do not', async () => {
    const limited = withAgentWriteQuota(store, { maxEntries: 1, maxBytes: 10_000 });
    const importer = { agent: 'importer:owner', originClass: 'agent' as const };
    const imported = await store.note(importer, { title: 'Imported', body: 'imported with the agent origin', kind: 'memory', source: { system: 'claude-memory', externalId: 'repo/a.md' } });
    await store.promote(imported.entry.slug, { standing: false });
    expect(await agentWriteUsage()).toMatchObject({ entries: 0 });
    expect((await limited.note(agent, { title: 'Agent', body: 'the one agent note the cap allows', kind: 'memory' })).created).toBe(true);
    await expect(limited.note(agent, { title: 'Over', body: 'one past the cap', kind: 'memory' })).rejects.toBeInstanceOf(BrainInputError);
  });

  it('never refuses an import for the agent cap, and counts an agent\'s correction of untrusted text', async () => {
    const limited = withAgentWriteQuota(store, { maxEntries: 1, maxBytes: 10_000 });
    await limited.note(agent, { title: 'Agent', body: 'fills the one slot', kind: 'memory' });
    const importer = { agent: 'importer:owner', originClass: 'agent' as const };
    expect((await limited.note(importer, { title: 'Imported', body: 'an import past the cap', kind: 'memory', source: { system: 'claude-memory', externalId: 'repo/b.md' } })).created).toBe(true);
    const untrusted = await store.note({ agent: 'importer:owner', originClass: 'untrusted' }, { title: 'Clip', body: 'clipped text', kind: 'doc', source: { system: 'clippings', externalId: 'c/1' } });
    await store.supersede(agent, untrusted.entry.slug, { body: 'clipped text, tidied', reason: 'tidy', expectedHash: untrusted.entry.contentHash });
    expect(await agentWriteUsage()).toMatchObject({ entries: 2 });
  });

  it('shares one index with the store across a swap made through either', async () => {
    const limited = withAgentWriteQuota(store, { maxEntries: 10, maxBytes: 10_000 });
    const swapped = openBrainIndex({ path: ':memory:', identity: testIdentity(config) });
    limited.setIndex(swapped);
    await limited.note(agent, { title: 'After', body: 'written after a swap through the wrapper', kind: 'memory' });
    expect(swapped.counts()).toEqual({ entries: 1, chunks: 1 });
    const again = openBrainIndex({ path: ':memory:', identity: testIdentity(config) });
    store.setIndex(again);
    await limited.note(agent, { title: 'Again', body: 'written after a swap through the store', kind: 'memory' });
    expect(again.counts()).toEqual({ entries: 1, chunks: 1 });
    expect(swapped.counts()).toEqual({ entries: 1, chunks: 1 });
  });

  it('bounds bytes as well as entries', async () => {
    const limited = withAgentWriteQuota(store, { maxEntries: 100, maxBytes: 40 });
    await limited.note(agent, { title: 'Short', body: 'twenty bytes of text', kind: 'memory' });
    await expect(limited.note(agent, { title: 'Long', body: 'this one would pass the forty byte cap', kind: 'memory' })).rejects.toBeInstanceOf(BrainInputError);
  });
});
