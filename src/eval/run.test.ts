import mongoose from 'mongoose';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createFakeEmbedder } from '../brain/embeddings/index.js';
import { openBrainIndex } from '../brain/index/sqlite.js';
import { BrainEntry } from '../brain/model.js';
import { identityOf } from '../brain/runtime.js';
import { BrainStore } from '../brain/store.js';
import { createStoreSink } from '../importers/framework.js';
import { testConfig } from '../test-support/brain.js';
import { startMongo, stopMongo } from '../test-support/mongo.js';
import { runLiveEval, seedRequests } from './run.js';

describe('live eval', () => {
  let uri: string;
  beforeAll(async () => {
    uri = await startMongo();
  });
  afterAll(stopMongo);

  it('counts a leak of a superseded fixture\'s retired original, not only of the alias that seeding records', async () => {
    const config = testConfig({ BRAIN_EMBED_DIMS: '256' });
    const embedder = createFakeEmbedder(256);
    const index = openBrainIndex({ path: ':memory:', identity: identityOf(config, embedder) });
    const store = new BrainStore({ index, embedder, config });

    // What `eval --seed` sends: every fixture, then each superseded fixture's identity again with its successor's body.
    await mongoose.connect(uri);
    await BrainEntry.init();
    const sink = createStoreSink({ store, agent: 'importer:eval' });
    for (const request of seedRequests()) {
      const result = await sink.put('eval', request.originClass, request.items.map((item) => ({ ...item, namespace: 'shared', originClass: 'agent' as const })));
      expect(result.rejected).toEqual([]);
    }
    const original = await BrainEntry.findOne({ 'source.system': 'eval', 'source.externalId': 'cutover-v1', live: false, supersededBy: { $exists: true } }).sort({ createdAt: 1 });
    expect(original?.title).toBe('Payments cutover state (old)');
    await mongoose.disconnect();

    const clean = await runLiveEval({ mongoUri: uri, config, embedder, index });
    expect(clean.summary).toMatchObject({ revocationLeaks: 0, revocationMisses: 0 });

    // A stale index that still serves the retired original as current must be reported as a leak.
    await mongoose.connect(uri);
    await BrainEntry.updateOne({ _id: original?._id }, { $set: { live: true }, $unset: { invalidAt: 1, expiredAt: 1, supersededBy: 1 } });
    const revived = await BrainEntry.findById(original?._id);
    if (!revived) { throw new Error('original version missing'); }
    await store.indexEntry(revived);
    await mongoose.disconnect();

    const leaking = await runLiveEval({ mongoUri: uri, config, embedder, index });
    expect(leaking.outcomes.find((outcome) => outcome.id === 'v01')).toMatchObject({ leaked: true });
    expect(leaking.summary.revocationLeaks).toBeGreaterThan(0);
    index.close();
  });
});
