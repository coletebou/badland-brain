import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { createFakeEmbedder } from '../brain/embeddings/index.js';
import { openBrainIndex } from '../brain/index/sqlite.js';
import { BrainStore } from '../brain/store.js';
import { testConfig, testIdentity } from '../test-support/brain.js';
import { clearTestDb, setupTestDb, teardownTestDb } from '../test-support/mongo.js';
import { type ToolCtx, type ToolDeps, actorOf, brainContext, brainForget, brainGet, brainList, brainNote, brainSearch, brainSupersede } from './handlers.js';
import { brainForgetSchema, brainNoteSchema } from './schemas.js';

const config = testConfig();
const ctx: ToolCtx = { agent: 'claude-code@laptop', role: 'agent' };
const alpha: ToolCtx = { agent: 'alpha@laptop', role: 'agent', namespaces: ['agent:alpha'] };

describe('brain tool handlers', () => {
  let deps: ToolDeps;

  beforeAll(setupTestDb);
  afterAll(teardownTestDb);
  beforeEach(async () => {
    await clearTestDb();
    const index = openBrainIndex({ path: ':memory:', identity: testIdentity(config) });
    const embedder = createFakeEmbedder(32);
    deps = { store: new BrainStore({ index, embedder, config }), search: { index, embedder, config }, config };
  });

  it('note derives origin from the key, never from input, and strips unknown fields at the boundary', async () => {
    expect(brainNoteSchema.safeParse({ title: 'T', body: 'pnpm always', kind: 'memory', originClass: 'owner' }).success).toBe(false);
    const result = await brainNote(deps)(ctx, { title: 'T', body: 'pnpm always', kind: 'memory' });
    expect(result).toMatchObject({ ok: true, data: { created: true, entry: { originClass: 'agent', authorAgent: 'claude-code@laptop', namespace: 'shared' } } });
    expect(actorOf({ agent: 'me', role: 'owner' })).toEqual({ agent: 'me', originClass: 'owner' });
    expect(actorOf({ agent: 'reader', role: 'read' })).toEqual({ agent: 'reader', originClass: 'agent' });
  });

  it('maps store errors to stable codes', async () => {
    expect(await brainGet(deps)(ctx, { slug: 'nope' })).toMatchObject({ ok: false, code: 'not_found' });
    const note = await brainNote(deps)(ctx, { title: 'Port', body: 'port is 4300', kind: 'reference' });
    if (!note.ok) { throw new Error('note failed'); }
    const conflict = await brainSupersede(deps)(ctx, { slug: note.data.entry.slug, body: 'port is 4310', reason: 'moved', expectedHash: 'f'.repeat(64) });
    expect(conflict).toMatchObject({ ok: false, code: 'conflict', currentHash: note.data.entry.contentHash });
    if (!conflict.ok) { expect(conflict.error).toContain(note.data.entry.contentHash); }
    expect(await brainNote(deps)(ctx, { title: 'S', body: `bbk_${'a'.repeat(43)}`, kind: 'memory' })).toMatchObject({ ok: false, code: 'bad_input' });
  });

  it('search finds notes and forget removes one entry by its exact import identity, never a whole source', async () => {
    await brainNote(deps)(ctx, { title: 'Ports', body: 'the preview server listens on 4310', kind: 'reference' });
    await brainNote(deps)(ctx, { title: 'Pkg', body: 'always pnpm', kind: 'memory' });
    const found = await brainSearch(deps)(ctx, { query: 'preview server port' });
    expect(found.ok && found.data.hits[0].slug).toMatch(/^ports-/u);
    const importer = { agent: 'importer', originClass: 'owner' as const };
    const stored = await deps.store.note(importer, { title: 'I', body: 'imported', kind: 'doc', source: { system: 'claude-memory', externalId: 'x' } });
    const other = await deps.store.note(importer, { title: 'J', body: 'imported too', kind: 'doc', source: { system: 'claude-memory', externalId: 'y' } });
    expect(stored.entry.originClass).toBe('owner');
    // The agent schema has no system-only form: a whole-source forget is an owner action, not a tool call.
    expect(brainForgetSchema.safeParse({ source: { system: 'claude-memory' }, reason: 'cleanup' }).success).toBe(false);
    expect(brainForgetSchema.safeParse({ source: { system: 'claude-memory', externalId: 'x' }, reason: 'cleanup' }).success).toBe(true);
    expect(await brainForget(deps)(ctx, { source: { system: 'claude-memory', externalId: 'x' }, reason: 'cleanup' })).toMatchObject({ ok: true, data: { forgotten: 1 } });
    expect(await deps.store.get(stored.entry.slug)).toBeNull();
    expect(await deps.store.get(other.entry.slug)).not.toBeNull();
    expect(await brainForget(deps)(ctx, { reason: 'nothing' })).toMatchObject({ ok: false, code: 'bad_input' });
  });

  it('confines a namespace-bound key: its notes land in its namespace, and it cannot read or name any other', async () => {
    const mine = await brainNote(deps)(alpha, { title: 'Mine', body: 'alpha remembers the build flag', kind: 'memory' });
    expect(mine).toMatchObject({ ok: true, data: { entry: { namespace: 'agent:alpha' } } });
    const theirs = await brainNote(deps)(ctx, { title: 'Theirs', body: 'shared knowledge about the build flag', kind: 'memory' });
    if (!theirs.ok) { throw new Error('note failed'); }
    const search = await brainSearch(deps)(alpha, { query: 'build flag' });
    expect(search.ok && search.data.hits.map((h) => h.namespace)).toEqual(['agent:alpha']);
    expect(await brainSearch(deps)(alpha, { query: 'build flag', namespace: 'shared' })).toMatchObject({ ok: false, code: 'bad_input' });
    expect(await brainGet(deps)(alpha, { slug: theirs.data.entry.slug })).toMatchObject({ ok: false, code: 'not_found' });
    const listed = await brainList(deps)(alpha, {});
    expect(listed.ok && listed.data.items.map((i) => i.namespace)).toEqual(['agent:alpha']);
    expect(await brainList(deps)(alpha, { namespace: 'shared' })).toMatchObject({ ok: false, code: 'bad_input' });
    expect(await brainNote(deps)(alpha, { title: 'Escape', body: 'writing into shared', kind: 'memory', namespace: 'shared' })).toMatchObject({ ok: false, code: 'bad_input' });
    expect(await brainSupersede(deps)(alpha, { slug: theirs.data.entry.slug, body: 'rewritten', reason: 'r', expectedHash: theirs.data.entry.contentHash })).toMatchObject({ ok: false, code: 'not_found' });
    expect(await brainForget(deps)(alpha, { slug: theirs.data.entry.slug, reason: 'r' })).toMatchObject({ ok: true, data: { forgotten: 0 } });
    expect(await brainContext(deps)(alpha, {})).toMatchObject({ ok: true, data: { namespaces: ['agent:alpha'] } });
    expect(await brainContext(deps)(alpha, { namespace: 'repo:other' })).toMatchObject({ ok: false, code: 'bad_input' });
    expect(await deps.store.get(theirs.data.entry.slug)).toMatchObject({ invalidAt: null });
  });
});
