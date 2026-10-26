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
    await expect(limited.note(agent, { title: 'Still full', body: 'history still counts', kind: 'memory' })).rejects.toThrow(/storage is full/u);
  });

  it('bounds bytes as well as entries', async () => {
    const limited = withAgentWriteQuota(store, { maxEntries: 100, maxBytes: 40 });
    await limited.note(agent, { title: 'Short', body: 'twenty bytes of text', kind: 'memory' });
    await expect(limited.note(agent, { title: 'Long', body: 'this one would pass the forty byte cap', kind: 'memory' })).rejects.toBeInstanceOf(BrainInputError);
  });
});
