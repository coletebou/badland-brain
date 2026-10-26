import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { clearTestDb, setupTestDb, teardownTestDb } from '../test-support/mongo.js';
import { BrainEntry, isValidNamespace } from './model.js';

const base = (): Record<string, unknown> => ({
  slug: 'pnpm-not-npm-a1b2c3',
  title: 'Use pnpm',
  body: 'Use pnpm, not npm.',
  kind: 'memory',
  tier: 'episodic',
  namespace: 'repo:example',
  originClass: 'agent',
  authorAgent: 'codex@laptop',
  importance: 5,
  validFrom: new Date(),
  contentHash: 'h1',
});

describe('BrainEntry', () => {
  beforeAll(setupTestDb);
  afterAll(teardownTestDb);
  beforeEach(clearTestDb);
  const create = (doc: Record<string, unknown>) => BrainEntry.create(doc as never);

  it('stores an entry with defaults and a unique slug', async () => {
    const seed = base();
    const doc = await create(seed);
    expect(doc.tags).toEqual([]);
    expect(doc.live).toBe(true);
    expect(doc.invalidAt).toBeUndefined();
    expect(doc.toJSON()).toHaveProperty('id');
    await expect(create({ ...seed, contentHash: 'h2' })).rejects.toThrow(/duplicate key/u);
  });

  it('rejects unknown kind, tier, origin class, and bad namespace', async () => {
    await expect(create({ ...base(), kind: 'sticky' })).rejects.toThrow();
    await expect(create({ ...base(), tier: 'gold' })).rejects.toThrow();
    await expect(create({ ...base(), originClass: 'god' })).rejects.toThrow();
    await expect(create({ ...base(), namespace: 'Repo:Bad Name' })).rejects.toThrow();
    await expect(create({ ...base(), importance: 11 })).rejects.toThrow();
  });

  it('validates namespaces', () => {
    expect(isValidNamespace('shared')).toBe(true);
    expect(isValidNamespace('repo:example')).toBe(true);
    expect(isValidNamespace('agent:codex@laptop')).toBe(true);
    expect(isValidNamespace('team:x')).toBe(false);
    expect(isValidNamespace('repo:Example')).toBe(false);
  });

  it('collapses identical live episodic bodies per namespace, but not curated copies, retired versions, or other namespaces', async () => {
    await create({ ...base(), slug: 'h1-a' });
    await expect(create({ ...base(), slug: 'h1-b' })).rejects.toThrow(/duplicate key/u);
    await create({ ...base(), slug: 'h1-curated', tier: 'curated' });
    await create({ ...base(), slug: 'h1-retired', live: false });
    await create({ ...base(), slug: 'h1-other-namespace', namespace: 'agent:codex' });
  });

  it('enforces a unique import identity among live entries only', async () => {
    const source = { system: 'claude-memory', externalId: 'example/a.md' };
    await create({ ...base(), slug: 's1', source });
    await expect(create({ ...base(), slug: 's2', contentHash: 'h2', source })).rejects.toThrow(/duplicate key/u);
    await create({ ...base(), slug: 's3', contentHash: 'h3' });
    await BrainEntry.updateOne({ slug: 's1' }, { $set: { live: false } });
    await create({ ...base(), slug: 's4', contentHash: 'h4', source }); // the retired version no longer blocks
  });
});
