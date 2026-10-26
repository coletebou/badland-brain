import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { testConfig } from '../test-support/brain.js';
import { clearTestDb, setupTestDb, teardownTestDb } from '../test-support/mongo.js';
import { buildContext, contextNamespaces } from './context.js';
import { BrainEntry } from './model.js';
import { BrainInputError } from './store-views.js';

const config = testConfig();

const entry = (over: Record<string, unknown>): Record<string, unknown> => ({
  slug: `s-${Math.random().toString(16).slice(2, 8)}`, title: 'T', body: 'body', tags: [], kind: 'memory', tier: 'episodic',
  namespace: 'shared', originClass: 'agent', authorAgent: 'a', importance: 5, validFrom: new Date('2026-01-01'), contentHash: Math.random().toString(16),
  ...over,
});

describe('buildContext', () => {
  beforeAll(setupTestDb);
  afterAll(teardownTestDb);
  beforeEach(clearTestDb);

  it('packs curated standing facts by importance within the budget and lists recent decisions', async () => {
    await BrainEntry.create([
      entry({ slug: 'high', title: 'High', body: 'pnpm always', tier: 'curated', tags: ['standing'], importance: 9 }),
      entry({ slug: 'mid', title: 'Mid', body: 'y'.repeat(12_000), tier: 'curated', tags: ['standing'], importance: 5 }),
      entry({ slug: 'low', title: 'Low', body: 'small', tier: 'curated', tags: ['standing'], importance: 1 }),
      entry({ slug: 'repo-only', title: 'Repo', body: 'repo-scoped fact', tier: 'curated', tags: ['standing'], importance: 10, namespace: 'repo:example' }),
      entry({ slug: 'episodic-standing', title: 'Nope', body: 'not curated', tier: 'episodic', tags: ['standing'], importance: 10 }),
      entry({ slug: 'tainted', title: 'Tainted', body: 'untrusted standing', tier: 'curated', tags: ['standing'], importance: 10, originClass: 'untrusted' }),
      entry({ slug: 'superseded', title: 'Old', body: 'old', tier: 'curated', tags: ['standing'], importance: 10, invalidAt: new Date() }),
      entry({ slug: 'd1', title: 'Decision one', kind: 'decision', validFrom: new Date('2026-02-01') }),
      entry({ slug: 'd2', title: 'Decision two', kind: 'decision', validFrom: new Date('2026-03-01'), namespace: 'repo:example' }),
      entry({ slug: 'd3', title: 'Injected', kind: 'decision', validFrom: new Date('2026-04-01'), originClass: 'untrusted' }),
      entry({ slug: 'd4', title: 'Scheduled', kind: 'decision', validFrom: new Date(Date.now() + 86_400_000) }),
      entry({ slug: 'd5', title: 'Ending soon', kind: 'decision', validFrom: new Date('2026-01-15'), invalidAt: new Date(Date.now() + 86_400_000) }),
    ] as never);
    const block = await buildContext(contextNamespaces(undefined), config);
    expect(block.standing.map((s) => s.slug)).toEqual(['high', 'mid']);
    expect(block.standing[1].body.endsWith('…')).toBe(true);
    expect(block.truncated).toBe(true);
    expect(block.tokens).toBeLessThanOrEqual(config.contextTokenBudget);
    // Without a namespace the block is `shared` only: another repo's standing facts and decisions stay out.
    expect(block.recentDecisions.map((d) => d.slug)).toEqual(['d1', 'd5']);
    expect(block.namespaces).toEqual(['shared']);
    expect(await buildContext(contextNamespaces('shared'), config)).toEqual(block);

    const scoped = await buildContext(contextNamespaces('repo:example'), config);
    expect(scoped.standing.map((s) => s.slug)).toEqual(['repo-only', 'high', 'mid']);
    expect(scoped.recentDecisions.map((d) => d.slug)).toEqual(['d2', 'd1', 'd5']);

    const other = await buildContext(contextNamespaces('repo:other'), config);
    expect(other.standing.map((s) => s.slug)).toEqual(['high', 'mid']);
    expect(other.recentDecisions.map((d) => d.slug)).toEqual(['d1', 'd5']);
  });

  it('returns an empty block when nothing is curated', async () => {
    expect(await buildContext(['shared'], config)).toEqual({ standing: [], recentDecisions: [], namespaces: ['shared'], tokens: 0, truncated: false });
  });
});

describe('contextNamespaces', () => {
  it('is shared plus the namespace asked for, limited to what a confined key may see', () => {
    expect(contextNamespaces(undefined)).toEqual(['shared']);
    expect(contextNamespaces('repo:example')).toEqual(['shared', 'repo:example']);
    expect(contextNamespaces(undefined, { namespaces: ['shared', 'agent:alpha'] })).toEqual(['shared']);
    expect(contextNamespaces('agent:alpha', { namespaces: ['shared', 'agent:alpha'] })).toEqual(['shared', 'agent:alpha']);
    expect(contextNamespaces('agent:alpha', { namespaces: ['agent:alpha'] })).toEqual(['agent:alpha']);
    expect(contextNamespaces(undefined, { namespaces: ['agent:alpha', 'repo:example'] })).toEqual(['agent:alpha', 'repo:example']);
    expect(() => contextNamespaces('agent:beta', { namespaces: ['agent:alpha'] })).toThrow(BrainInputError);
  });
});
