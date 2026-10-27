import { type Server, createServer } from 'node:http';
import type { AddressInfo } from 'node:net';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { KeyStore, mintKey } from '../auth/keys.js';
import { createFakeEmbedder } from '../brain/embeddings/index.js';
import { openBrainIndex } from '../brain/index/sqlite.js';
import { BrainEntry, MAX_BODY_CHARS } from '../brain/model.js';
import { type BrainRuntime, identityOf } from '../brain/runtime.js';
import { BrainStore } from '../brain/store.js';
import { type ImportItem, type Importer, createApiSink, runImport } from '../importers/framework.js';
import { BRAIN_MAX_TOOL_INPUT_ELEMENTS } from '../mcp/server.js';
import { testConfig } from '../test-support/brain.js';
import { setupTestDb, teardownTestDb } from '../test-support/mongo.js';
import { createApp } from './app.js';

const keys = {
  agent: mintKey({ name: 'codex@laptop', role: 'agent' }),
  read: mintKey({ name: 'reader@laptop', role: 'read' }),
  owner: mintKey({ name: 'owner@laptop', role: 'owner' }),
  alpha: mintKey({ name: 'alpha@laptop', role: 'agent', namespaces: ['agent:alpha'] }),
  limited: mintKey({ name: 'limited@laptop', role: 'agent' }),
};

async function connect(url: string, key: string): Promise<Client> {
  const client = new Client({ name: 'test-client', version: '0.0.0' });
  await client.connect(new StreamableHTTPClientTransport(new URL(url), { requestInit: { headers: { Authorization: `Bearer ${key}` } } }));
  return client;
}

describe('the HTTP app', () => {
  let server: Server;
  let base: string;
  let runtime: BrainRuntime;
  const call = (key: string | null, method: string, path: string, body?: unknown, headers: Record<string, string> = {}) =>
    fetch(`${base}${path}`, { method, headers: { ...(key ? { Authorization: `Bearer ${key}` } : {}), 'content-type': 'application/json', ...headers }, body: body === undefined ? undefined : JSON.stringify(body) });
  const data = async <T>(response: Response): Promise<T> => ((await response.json()) as { data: T }).data;

  beforeAll(async () => {
    await setupTestDb();
    const config = testConfig();
    const embedder = createFakeEmbedder(32);
    const index = openBrainIndex({ path: ':memory:', identity: identityOf(config, embedder) });
    runtime = { config, index, embedder, store: new BrainStore({ index, embedder, config }), stale: false };
    const store = new KeyStore({ inline: JSON.stringify(Object.values(keys).map((k) => k.record)) });
    const app = createApp({ runtime, keys: store, logger: { debug() {}, info() {}, warn() {}, error() {} }, rateLimitPerMinute: 10_000, writeRateLimitPerMinute: 10_000 });
    // A second app with tight limits for the rate-limit test.
    server = createServer(app);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    runtime.index.close();
    await teardownTestDb();
  });

  it('serves health without a key, and refuses missing, unknown and malformed keys with a challenge', async () => {
    const health = await fetch(`${base}/healthz`);
    expect(health.status).toBe(200);
    expect(await health.json()).toMatchObject({ ok: true, stale: false, model: 'fake', dims: 32 });
    for (const auth of [undefined, 'Bearer', `Bearer bbk_${'z'.repeat(43)}`, `Basic ${keys.agent.raw}`, `Bearer ${keys.agent.raw} extra`]) {
      const res = await fetch(`${base}/api/entries`, { headers: auth ? { Authorization: auth } : {} });
      expect(res.status).toBe(401);
      expect(res.headers.get('www-authenticate')).toMatch(/^Bearer realm="badland-brain"/u);
    }
    expect((await call(null, 'POST', '/mcp', {})).status).toBe(401);
    expect((await call(keys.agent.raw, 'GET', '/nope')).status).toBe(404);
  });

  it('lists seven tools for an agent key and four for a read key, and refuses owner keys on /mcp', async () => {
    const agent = await connect(`${base}/mcp`, keys.agent.raw);
    expect((await agent.listTools()).tools.map((t) => t.name).sort()).toEqual(['brain_context', 'brain_forget', 'brain_get', 'brain_list', 'brain_note', 'brain_search', 'brain_supersede']);
    await agent.close();
    const reader = await connect(`${base}/mcp`, keys.read.raw);
    expect((await reader.listTools()).tools.map((t) => t.name).sort()).toEqual(['brain_context', 'brain_get', 'brain_list', 'brain_search']);
    const refused = await reader.callTool({ name: 'brain_note', arguments: { title: 'T', body: 'read keys cannot write', kind: 'memory' } }).catch((e: Error) => e);
    expect(String(refused instanceof Error ? refused.message : JSON.stringify(refused))).toMatch(/brain_note/u);
    await reader.close();
    const owner = await fetch(`${base}/mcp`, { method: 'POST', headers: { Authorization: `Bearer ${keys.owner.raw}`, 'content-type': 'application/json', accept: 'application/json, text/event-stream' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'x', version: '1' } } }) });
    expect(owner.status).toBe(403);
    expect(owner.headers.get('www-authenticate')).toContain('insufficient_scope');
  });

  it('round-trips a note through brain_note and brain_search with attribution', async () => {
    const client = await connect(`${base}/mcp`, keys.agent.raw);
    const saved = await client.callTool({ name: 'brain_note', arguments: { title: 'Ports', body: 'the preview server listens on 4310', kind: 'reference' } });
    const savedData = saved.structuredContent as { entry: { slug: string; authorAgent: string; originClass: string }; created: boolean };
    expect(savedData).toMatchObject({ created: true, entry: { authorAgent: 'codex@laptop', originClass: 'agent' } });
    const found = await client.callTool({ name: 'brain_search', arguments: { query: 'preview server port' } });
    expect((found.structuredContent as { hits: Array<{ slug: string }> }).hits[0].slug).toBe(savedData.entry.slug);
    const missing = await client.callTool({ name: 'brain_get', arguments: { slug: 'nope' } });
    expect(missing.isError).toBe(true);
    await client.close();
  });

  it('refuses a tool call whose arguments hold more elements than any brain tool takes', async () => {
    const client = await connect(`${base}/mcp`, keys.agent.raw);
    const refused = await client.callTool({ name: 'brain_search', arguments: { query: 'ports', padding: Array.from({ length: BRAIN_MAX_TOOL_INPUT_ELEMENTS }, () => 0) } });
    expect(refused.isError).toBe(true);
    expect(JSON.stringify(refused.content)).toContain(`maximum of ${BRAIN_MAX_TOOL_INPUT_ELEMENTS} elements`);
    await client.close();
  });

  it('answers wrong methods with 405 and oversized or broken bodies with JSON errors', async () => {
    const get = await fetch(`${base}/mcp`, { method: 'GET', headers: { Authorization: `Bearer ${keys.agent.raw}` } });
    expect(get.status).toBe(405);
    expect(get.headers.get('allow')).toBe('POST');
    const big = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'brain_note', arguments: { body: 'x'.repeat(1100 * 1024) } } });
    const tooLarge = await fetch(`${base}/mcp`, { method: 'POST', headers: { 'content-type': 'application/json', Authorization: `Bearer ${keys.agent.raw}` }, body: big });
    expect(tooLarge.status).toBe(413);
    expect(await tooLarge.json()).toMatchObject({ code: 'payload_too_large' });
    const broken = await fetch(`${base}/api/note`, { method: 'POST', headers: { 'content-type': 'application/json', Authorization: `Bearer ${keys.agent.raw}` }, body: '{"title": ' });
    expect(broken.status).toBe(400);
  });

  it('serves the REST twins: reads to every role, writes to agent and owner keys only', async () => {
    const created = await call(keys.agent.raw, 'POST', '/api/note', { title: 'Read scope', body: 'read keys may read this decision', kind: 'decision', namespace: 'repo:readscope' });
    expect(created.status).toBe(200);
    const { entry } = await data<{ entry: { slug: string; contentHash: string } }>(created);
    for (const key of [keys.read.raw, keys.agent.raw, keys.owner.raw]) {
      const search = await call(key, 'GET', '/api/search?query=read%20keys%20decision&kinds=decision&namespace=repo:readscope&topK=3');
      expect((await data<{ hits: Array<{ slug: string }> }>(search)).hits.map((h) => h.slug)).toContain(entry.slug);
      expect((await data<{ items: Array<{ slug: string }> }>(await call(key, 'GET', '/api/entries?namespace=repo:readscope&kind=decision&current=true'))).items.map((i) => i.slug)).toEqual([entry.slug]);
      expect(await data(await call(key, 'GET', `/api/entries/${entry.slug}`))).toMatchObject({ slug: entry.slug, body: 'read keys may read this decision', contentHash: entry.contentHash });
      expect((await data<{ recentDecisions: Array<{ slug: string }> }>(await call(key, 'GET', '/api/context?namespace=repo:readscope'))).recentDecisions.map((d) => d.slug)).toContain(entry.slug);
      expect((await call(key, 'GET', '/api/entries/nope')).status).toBe(404);
    }
    expect((await call(keys.read.raw, 'POST', '/api/note', { title: 'Sneaky', body: 'a read key tried to write', kind: 'memory' })).status).toBe(403);
    expect((await call(keys.read.raw, 'POST', '/api/supersede', { slug: entry.slug, body: 'overwritten', reason: 'r', expectedHash: entry.contentHash })).status).toBe(403);
    expect((await call(keys.read.raw, 'POST', '/api/forget', { slug: entry.slug, reason: 'r' })).status).toBe(403);
    expect(await BrainEntry.countDocuments({ title: 'Sneaky' })).toBe(0);
    const stale = await call(keys.agent.raw, 'POST', '/api/supersede', { slug: entry.slug, body: 'changed', reason: 'moved', expectedHash: 'f'.repeat(64) });
    expect(stale.status).toBe(409);
    expect(((await stale.json()) as { currentHash: string }).currentHash).toBe(entry.contentHash);
    expect((await call(keys.agent.raw, 'POST', '/api/note', { title: 'T', body: 'x', kind: 'memory', originClass: 'owner' })).status).toBe(400);
  });

  it('confines a namespace-bound key over REST exactly as over MCP', async () => {
    const shared = await data<{ entry: { slug: string; contentHash: string } }>(await call(keys.agent.raw, 'POST', '/api/note', { title: 'Shared fact', body: 'everyone shares the staging hostname convention', kind: 'memory' }));
    const mine = await data<{ entry: { slug: string; namespace: string } }>(await call(keys.alpha.raw, 'POST', '/api/note', { title: 'Alpha fact', body: 'alpha keeps the staging hostname convention too', kind: 'memory' }));
    expect(mine.entry.namespace).toBe('agent:alpha');
    expect((await data<{ hits: Array<{ namespace: string }> }>(await call(keys.alpha.raw, 'GET', '/api/search?query=staging%20hostname%20convention'))).hits.map((h) => h.namespace)).toEqual(['agent:alpha']);
    expect((await call(keys.alpha.raw, 'GET', `/api/entries/${shared.entry.slug}`)).status).toBe(404);
    expect((await call(keys.alpha.raw, 'GET', '/api/entries?namespace=shared')).status).toBe(400);
    expect((await call(keys.alpha.raw, 'POST', '/api/supersede', { slug: shared.entry.slug, body: 'b', reason: 'r', expectedHash: shared.entry.contentHash })).status).toBe(404);
    expect((await call(keys.alpha.raw, 'POST', '/api/note', { title: 'Out', body: 'into shared', kind: 'memory', namespace: 'shared' })).status).toBe(400);
  });

  it('keeps the owner operations to owner keys: import, promote, reindex and whole-source forget', async () => {
    const note = await data<{ entry: { slug: string } }>(await call(keys.agent.raw, 'POST', '/api/note', { title: 'Standing rule', body: 'promote me through the api', kind: 'memory' }));
    for (const key of [keys.agent.raw, keys.read.raw, keys.alpha.raw]) {
      expect((await call(key, 'POST', '/api/promote', { slug: note.entry.slug })).status).toBe(403);
      expect((await call(key, 'POST', '/api/import', { originClass: 'owner', items: [{ externalId: 'r/1', title: 'T', body: 'x', kind: 'memory' }] })).status).toBe(403);
      expect((await call(key, 'GET', '/api/reindex')).status).toBe(403);
      expect((await call(key, 'POST', '/api/forget-source', { source: { system: 'clippings' }, reason: 'r' })).status).toBe(403);
    }
    expect((await call(keys.owner.raw, 'POST', '/api/promote', { slug: 'nope' })).status).toBe(404);
    const promoted = await call(keys.owner.raw, 'POST', '/api/promote', { slug: note.entry.slug, standing: true });
    expect(promoted.status).toBe(200);
    const curated = await data<{ slug: string; tier: string; tags: string[]; contentHash: string }>(promoted);
    expect(curated).toMatchObject({ tier: 'curated', tags: expect.arrayContaining(['standing']) });
    // Only the owner changes the curated tier.
    expect((await call(keys.agent.raw, 'POST', '/api/supersede', { slug: curated.slug, body: 'agent edit', reason: 'r', expectedHash: curated.contentHash })).status).toBe(400);
    expect((await call(keys.agent.raw, 'POST', '/api/forget', { slug: curated.slug, reason: 'r' })).status).toBe(400);
    const corrected = await call(keys.owner.raw, 'POST', '/api/supersede', { slug: curated.slug, body: 'the owner\'s correction', reason: 'r', expectedHash: curated.contentHash });
    expect(await data(corrected)).toMatchObject({ tier: 'curated', originClass: 'owner', authorAgent: 'owner@laptop' });
    expect((await call(keys.owner.raw, 'POST', '/api/reindex')).status).toBe(202);
  });

  it('imports idempotently with a top-level origin class and refuses forged lineage sources', async () => {
    const items = [
      { externalId: 'example/a.md', title: 'A', body: 'alpha imported text', kind: 'memory', namespace: 'repo:imported' },
      { externalId: 'example/b.md', title: 'B', body: 'beta imported text', kind: 'reference' },
    ];
    const first = await call(keys.owner.raw, 'POST', '/api/import', { originClass: 'owner', items }, { 'x-brain-source': 'claude-memory' });
    expect(await data(first)).toEqual({ created: 2, skipped: 0, retired: 0, rejected: [] });
    expect(await data(await call(keys.owner.raw, 'POST', '/api/import', { originClass: 'owner', items }, { 'x-brain-source': 'claude-memory' }))).toEqual({ created: 0, skipped: 2, retired: 0, rejected: [] });
    const listed = await data<{ items: Array<{ originClass: string; authorAgent: string }> }>(await call(keys.agent.raw, 'GET', '/api/entries?namespace=repo:imported'));
    expect(listed.items).toEqual([expect.objectContaining({ originClass: 'owner', authorAgent: 'importer:owner@laptop' })]);
    expect((await call(keys.owner.raw, 'POST', '/api/import', { originClass: 'system', items })).status).toBe(400);
    for (const forged of ['promote', 'supersede', 'Not A Slug']) {
      expect((await call(keys.owner.raw, 'POST', '/api/import', { originClass: 'owner', items }, { 'x-brain-source': forged })).status).toBe(400);
    }
  });

  it('agent forget selects one entry; retiring a whole import source is the owner\'s route', async () => {
    const items = [
      { externalId: 'wd/1', title: 'One', body: 'withdrawn source item one', kind: 'memory', namespace: 'repo:withdrawn' },
      { externalId: 'wd/2', title: 'Two', body: 'withdrawn source item two', kind: 'memory', namespace: 'repo:withdrawn' },
    ];
    expect((await call(keys.owner.raw, 'POST', '/api/import', { originClass: 'owner', items }, { 'x-brain-source': 'clippings' })).status).toBe(200);
    expect((await call(keys.agent.raw, 'POST', '/api/forget', { source: { system: 'clippings' }, reason: 'sweep' })).status).toBe(400);
    expect(await data(await call(keys.agent.raw, 'POST', '/api/forget', { source: { system: 'clippings', externalId: 'wd/1' }, reason: 'retracted' }))).toEqual({ forgotten: 1 });
    expect((await call(keys.owner.raw, 'POST', '/api/forget-source', { source: { system: 'clippings', externalId: 'wd/2' }, reason: 'withdrawn' })).status).toBe(400);
    expect((await call(keys.owner.raw, 'POST', '/api/forget-source', { source: { system: 'promote' }, reason: 'sweep' })).status).toBe(400);
    expect(await data(await call(keys.owner.raw, 'POST', '/api/forget-source', { source: { system: 'clippings' }, reason: 'withdrawn' }))).toEqual({ forgotten: 1 });
    expect((await data<{ items: unknown[] }>(await call(keys.agent.raw, 'GET', '/api/entries?namespace=repo:withdrawn'))).items).toHaveLength(0);
  });

  it('imports a body over the limit as ordered parts through the route, idempotently, beside an item the route would refuse', async () => {
    const day = Array.from({ length: 430 }, (_, i) => `## Entry ${i}\n\nworked through item ${i}: ${'notes on the plan '.repeat(30)}\n`).join('\n');
    expect(day.length).toBeGreaterThan(2 * MAX_BODY_CHARS);
    const shared = { kind: 'memory' as const, tags: ['source:openclaw'], namespace: 'agent:helper-bot', originClass: 'agent' as const };
    const items: ImportItem[] = [
      { ...shared, externalId: 'helper-bot/memory/2026-10-01.md', title: 'helper-bot notes 2026-10-01', body: day, capturedAt: new Date('2026-10-01T12:00:00Z') },
      { ...shared, externalId: 'helper-bot/memory/topics/speakers.md', title: 'Speaker setup', body: 'volume 30 in the kitchen' },
      { ...shared, externalId: 'helper-bot/memory/topics/long-tag.md', title: 'Long tag', body: 'refused for its tag', tags: ['t'.repeat(51)] },
    ];
    const importer: Importer = { source: 'openclaw-workspace', async *scan() { yield* items; } };
    const sink = createApiSink({ origin: base, key: keys.owner.raw });
    expect(await runImport(importer, sink, { paths: [], dryRun: false })).toEqual({ scanned: 3, excluded: 0, split: 1, created: 4, skipped: 0, retired: 0, rejected: 1 });
    expect(await runImport(importer, sink, { paths: [], dryRun: false })).toEqual({ scanned: 3, excluded: 0, split: 1, created: 0, skipped: 4, retired: 0, rejected: 1 });
    const parts = (await BrainEntry.find({ 'source.system': 'openclaw-workspace', live: true, 'source.externalId': /#part-/u }).lean())
      .sort((a, b) => (a.source?.externalId ?? '').localeCompare(b.source?.externalId ?? ''));
    expect(parts.map((entry) => entry.title)).toEqual([1, 2, 3].map((n) => `helper-bot notes 2026-10-01 (part ${n}/3)`));
    expect(parts.map((entry) => entry.body).join('')).toBe(day);

    const liveParts = async (): Promise<string[]> => (await BrainEntry.find({ 'source.system': 'openclaw-workspace', live: true, 'source.externalId': /^helper-bot\/memory\/2026-10-01\.md/u }).lean())
      .map((entry) => entry.source?.externalId ?? '').sort();
    // The day shrinks to two parts: the third is retired, and nothing of it stays current.
    items[0] = { ...items[0], body: day.slice(0, 130_000) };
    expect(await runImport(importer, sink, { paths: [], dryRun: false })).toMatchObject({ split: 1, retired: 1, rejected: 1 });
    expect(await liveParts()).toEqual([1, 2].map((n) => `helper-bot/memory/2026-10-01.md#part-${n}`));
    // It shrinks under the limit: the whole item retires both parts, counted in entries (part 2 with the version it had as one of three).
    items[0] = { ...items[0], body: 'a short day after all' };
    expect(await runImport(importer, sink, { paths: [], dryRun: false })).toMatchObject({ split: 0, created: 1, retired: 3, rejected: 1 });
    expect(await liveParts()).toEqual(['helper-bot/memory/2026-10-01.md']);
  });

  it('meters requests and writes per key, answering 429 with Retry-After', async () => {
    const tight = createApp({ runtime, keys: new KeyStore({ inline: JSON.stringify([keys.limited.record]) }), logger: { debug() {}, info() {}, warn() {}, error() {} }, rateLimitPerMinute: 3, writeRateLimitPerMinute: 1 });
    const tightServer = createServer(tight);
    await new Promise<void>((resolve) => tightServer.listen(0, '127.0.0.1', resolve));
    const url = `http://127.0.0.1:${(tightServer.address() as AddressInfo).port}`;
    try {
      const post = (body: unknown) => fetch(`${url}/api/note`, { method: 'POST', headers: { Authorization: `Bearer ${keys.limited.raw}`, 'content-type': 'application/json' }, body: JSON.stringify(body) });
      expect((await post({ title: 'One', body: 'first metered note', kind: 'memory' })).status).toBe(200);
      const second = await post({ title: 'Two', body: 'second metered note', kind: 'memory' });
      expect(second.status).toBe(429);
      expect(Number(second.headers.get('retry-after'))).toBeGreaterThan(0);
      expect((await fetch(`${url}/api/entries`, { headers: { Authorization: `Bearer ${keys.limited.raw}` } })).status).toBe(200);
      expect((await fetch(`${url}/api/entries`, { headers: { Authorization: `Bearer ${keys.limited.raw}` } })).status).toBe(429);
    } finally {
      await new Promise<void>((resolve) => tightServer.close(() => resolve()));
    }
  });
});
