import type { ChildProcess } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { assertBuilt, mcpClient, runCli, startServe, stopServe, tool, toolError } from './helpers.js';

interface Entry { slug: string; namespace: string; tier: string; contentHash: string; supersededBy: string | null; originClass: string; authorAgent: string; tags: string[] }
interface Hit { slug: string; namespace: string; textRank: number | null; vecRank: number | null; similarity: number | null }
interface Read extends Entry { body: string; history: Array<{ slug: string }> }

describe('badland-brain end to end: the built server, a real MongoDB, MCP clients', () => {
  let mongo: MongoMemoryServer;
  let dataDir: string;
  let env: NodeJS.ProcessEnv;
  let server: { child: ChildProcess; url: string; logs: () => string };
  const keys: Record<string, string> = {};
  const clients: Record<string, Client> = {};
  const owner = (args: string[], input?: string) => runCli(args, { ...env, BRAIN_URL: server.url, BRAIN_KEY: keys.owner }, input);

  beforeAll(async () => {
    assertBuilt();
    mongo = await MongoMemoryServer.create({ instance: { launchTimeout: 60_000, args: ['--nounixsocket'] } });
    dataDir = mkdtempSync(join(tmpdir(), 'brain-e2e-'));
    env = {
      PATH: process.env.PATH, HOME: dataDir,
      BRAIN_DATA_DIR: dataDir, BRAIN_MONGODB_URI: mongo.getUri('brain-e2e'), BRAIN_PORT: '0',
      BRAIN_EMBED_PROVIDER: 'fake', BRAIN_EMBED_DIMS: '64', BRAIN_LOG_LEVEL: 'info',
    };
    // Keys are minted with the real command, into the keys file the server reads.
    for (const [name, args] of Object.entries({
      owner: ['--name', 'owner@e2e', '--role', 'owner'],
      agent: ['--name', 'codex@e2e', '--role', 'agent'],
      reader: ['--name', 'reader@e2e', '--role', 'read'],
      alpha: ['--name', 'alpha@e2e', '--role', 'agent', '--namespace', 'agent:alpha'],
      beta: ['--name', 'beta@e2e', '--role', 'agent', '--namespace', 'agent:beta', '--namespace', 'shared'],
    })) {
      const minted = await runCli(['keys', 'mint', ...args], env);
      expect(minted.code, minted.stderr).toBe(0);
      keys[name] = minted.stdout.trim();
    }
    server = await startServe(env);
    for (const name of ['agent', 'reader', 'alpha', 'beta']) {
      clients[name] = await mcpClient(server.url, keys[name]);
    }
  });

  afterAll(async () => {
    await Promise.all(Object.values(clients).map((client) => client.close()));
    if (server) {
      expect(await stopServe(server.child)).toBe(0);
    }
    await mongo?.stop();
    rmSync(dataDir, { recursive: true, force: true });
  });

  it('is healthy, lists the tools each role may use, and refuses missing, unknown and owner keys on /mcp', async () => {
    expect(await (await fetch(`${server.url}/healthz`)).json()).toMatchObject({ ok: true, stale: false, model: 'fake', dims: 64 });
    expect((await clients.agent.listTools()).tools).toHaveLength(7);
    expect((await clients.reader.listTools()).tools.map((t) => t.name).sort()).toEqual(['brain_context', 'brain_get', 'brain_list', 'brain_search']);
    const initialize = { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'x', version: '1' } } };
    const post = (key?: string) => fetch(`${server.url}/mcp`, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...(key ? { Authorization: `Bearer ${key}` } : {}) }, body: JSON.stringify(initialize) });
    expect((await post()).status).toBe(401);
    expect((await post(`bbk_${'x'.repeat(43)}`)).status).toBe(401);
    expect((await post(keys.owner)).status).toBe(403);
    expect(await toolError(clients.reader, 'brain_note', { title: 'T', body: 'readers cannot write', kind: 'memory' })).toMatch(/brain_note/u);
  });

  it('notes, then finds the note by keyword and by vector, with provenance', async () => {
    const saved = await tool<{ entry: Entry; created: boolean }>(clients.agent, 'brain_note', { title: 'Preview ports', body: 'The docs preview server listens on 4310 behind the dev proxy on 4311.', kind: 'reference', tags: ['ports'] });
    expect(saved).toMatchObject({ created: true, entry: { namespace: 'shared', tier: 'episodic', originClass: 'agent', authorAgent: 'codex@e2e' } });
    const { hits } = await tool<{ hits: Hit[] }>(clients.agent, 'brain_search', { query: 'which port does the docs preview server use' });
    expect(hits[0]).toMatchObject({ slug: saved.entry.slug });
    expect(hits[0].textRank).not.toBeNull();
    expect(hits[0].vecRank).not.toBeNull();

    // Every word of this query is a keyword-leg stopword, so only the vector leg can find the note.
    const plans = await tool<{ entry: Entry }>(clients.agent, 'brain_note', { title: 'Plans', body: 'where should we go when it is done', kind: 'memory' });
    const vector = await tool<{ hits: Hit[] }>(clients.agent, 'brain_search', { query: 'where should we' });
    expect(vector.hits[0]).toMatchObject({ slug: plans.entry.slug, textRank: null, vecRank: 1 });
    expect(vector.hits[0].similarity).toBeGreaterThan(0.3);
    // The read-only key finds the same note.
    expect((await tool<{ hits: Hit[] }>(clients.reader, 'brain_search', { query: 'docs preview server port' })).hits[0].slug).toBe(saved.entry.slug);
  });

  it('supersedes with the content hash, keeping the old version as history and out of search', async () => {
    const { entry } = await tool<{ entry: Entry }>(clients.agent, 'brain_note', { title: 'Search port', body: 'The search service API listens on port 7700.', kind: 'reference' });
    const stale = await toolError(clients.agent, 'brain_supersede', { slug: entry.slug, body: 'x', reason: 'stale hash', expectedHash: 'f'.repeat(64) });
    expect(stale).toContain(entry.contentHash);
    const next = await tool<Entry>(clients.agent, 'brain_supersede', { slug: entry.slug, body: 'The search service API moved to port 7702; 7700 is retired.', reason: 'port moved', expectedHash: entry.contentHash });
    const old = await tool<Read>(clients.agent, 'brain_get', { slug: entry.slug });
    expect(old.supersededBy).toBe(next.slug);
    expect((await tool<Read>(clients.agent, 'brain_get', { slug: next.slug })).history.map((h) => h.slug)).toEqual([entry.slug]);
    const { hits } = await tool<{ hits: Hit[] }>(clients.agent, 'brain_search', { query: 'search service API port' });
    expect(hits.map((h) => h.slug)).toContain(next.slug);
    expect(hits.map((h) => h.slug)).not.toContain(entry.slug);
  });

  it('lists newest first, with or without superseded versions, and forgets', async () => {
    const first = await tool<{ entry: Entry }>(clients.agent, 'brain_note', { title: 'List one', body: 'first entry for the list test', kind: 'handoff', namespace: 'repo:listing' });
    const second = await tool<{ entry: Entry }>(clients.agent, 'brain_note', { title: 'List two', body: 'second entry for the list test', kind: 'handoff', namespace: 'repo:listing' });
    const listed = await tool<{ items: Entry[] }>(clients.agent, 'brain_list', { namespace: 'repo:listing' });
    expect(listed.items.map((i) => i.slug)).toEqual([second.entry.slug, first.entry.slug]);
    expect(await tool(clients.agent, 'brain_forget', { slug: first.entry.slug, reason: 'test cleanup' })).toEqual({ forgotten: 1 });
    expect((await tool<{ items: Entry[] }>(clients.agent, 'brain_list', { namespace: 'repo:listing', current: true })).items.map((i) => i.slug)).toEqual([second.entry.slug]);
    expect(await toolError(clients.agent, 'brain_get', { slug: first.entry.slug })).toMatch(/not_found/u);
    const { hits } = await tool<{ hits: Hit[] }>(clients.agent, 'brain_search', { query: 'first entry for the list test', namespace: 'repo:listing' });
    expect(hits.map((h) => h.slug)).not.toContain(first.entry.slug);
  });

  it('confines a namespace-bound key: it can neither read nor write another namespace', async () => {
    const mine = await tool<{ entry: Entry }>(clients.alpha, 'brain_note', { title: 'Alpha secret sauce', body: 'alpha bakes the release candidate on thursdays', kind: 'memory' });
    expect(mine.entry.namespace).toBe('agent:alpha');
    const theirs = await tool<{ entry: Entry }>(clients.beta, 'brain_note', { title: 'Beta schedule', body: 'beta bakes the release candidate on fridays', kind: 'memory' });
    expect(theirs.entry.namespace).toBe('agent:beta');

    // Reads: beta's entry does not exist for alpha, in search, list or get, and alpha's does not exist for beta.
    const alphaSearch = await tool<{ hits: Hit[] }>(clients.alpha, 'brain_search', { query: 'bakes the release candidate' });
    expect(alphaSearch.hits.map((h) => h.namespace)).toEqual(['agent:alpha']);
    const betaSearch = await tool<{ hits: Hit[] }>(clients.beta, 'brain_search', { query: 'bakes the release candidate' });
    expect(betaSearch.hits.map((h) => h.slug)).not.toContain(mine.entry.slug);
    expect(await toolError(clients.beta, 'brain_get', { slug: mine.entry.slug })).toMatch(/not_found/u);
    expect(await toolError(clients.alpha, 'brain_get', { slug: theirs.entry.slug })).toMatch(/not_found/u);
    expect((await tool<{ items: Entry[] }>(clients.alpha, 'brain_list', {})).items.every((i) => i.namespace === 'agent:alpha')).toBe(true);
    expect(await toolError(clients.alpha, 'brain_search', { query: 'release candidate', namespace: 'agent:beta' })).toMatch(/outside this key's namespaces/u);

    // Writes: no note, correction or forget reaches the other namespace.
    expect(await toolError(clients.beta, 'brain_note', { title: 'Into alpha', body: 'beta writing into alpha', kind: 'memory', namespace: 'agent:alpha' })).toMatch(/outside this key's namespaces/u);
    expect(await toolError(clients.beta, 'brain_supersede', { slug: mine.entry.slug, body: 'beta rewrote this', reason: 'x', expectedHash: mine.entry.contentHash })).toMatch(/not_found/u);
    expect(await tool(clients.beta, 'brain_forget', { slug: mine.entry.slug, reason: 'beta tried' })).toEqual({ forgotten: 0 });
    expect(await tool<Read>(clients.alpha, 'brain_get', { slug: mine.entry.slug })).toMatchObject({ body: 'alpha bakes the release candidate on thursdays', supersededBy: null });
  });

  it('lets only the owner write the curated tier: promote through the CLI, then agents cannot change it', async () => {
    const { entry } = await tool<{ entry: Entry }>(clients.agent, 'brain_note', { title: 'Deploy rule', body: 'Deploys go through CI only; nobody deploys from a laptop.', kind: 'decision' });
    const refused = await fetch(`${server.url}/api/promote`, { method: 'POST', headers: { Authorization: `Bearer ${keys.agent}`, 'content-type': 'application/json' }, body: JSON.stringify({ slug: entry.slug }) });
    expect(refused.status).toBe(403);
    const promoted = await owner(['promote', entry.slug, '--standing']);
    expect(promoted.code, promoted.stderr).toBe(0);
    const curated = JSON.parse(promoted.stdout) as Entry;
    expect(curated).toMatchObject({ tier: 'curated', tags: expect.arrayContaining(['standing']) });
    expect(await toolError(clients.agent, 'brain_supersede', { slug: curated.slug, body: 'Deploy from anywhere.', reason: 'agent edit', expectedHash: curated.contentHash })).toMatch(/only by the owner/u);
    expect(await toolError(clients.agent, 'brain_forget', { slug: curated.slug, reason: 'agent forget' })).toMatch(/only by the owner/u);
    const context = await tool<{ standing: Array<{ slug: string }> }>(clients.reader, 'brain_context', {});
    expect(context.standing.map((s) => s.slug)).toEqual([curated.slug]);
    // The owner can correct it, and the correction stays curated.
    const corrected = await owner(['supersede', curated.slug, '--reason', 'clarify', '--body-file', '-'], 'Deploys go through CI only, from the main branch.');
    expect(corrected.code, corrected.stderr).toBe(0);
    expect(JSON.parse(corrected.stdout)).toMatchObject({ tier: 'curated', originClass: 'owner', authorAgent: 'owner@e2e' });
  });

  it('imports, reindexes and retires an import source through the owner CLI', async () => {
    const memory = join(dataDir, 'claude-memory', 'web-app');
    mkdirSync(memory, { recursive: true });
    writeFileSync(join(memory, 'queue.md'), '---\nname: Thumbnail queue\ntype: reference\n---\nThe thumbnail queue worker runs with concurrency 4.');
    writeFileSync(join(memory, 'MEMORY.md'), '# index');
    const dry = await owner(['import', 'claude-memory', '--path', memory, '--dry-run']);
    expect(JSON.parse(dry.stdout)).toMatchObject({ dryRun: true, scanned: 1, created: 0 });
    const imported = await owner(['import', 'claude-memory', '--path', memory]);
    expect(imported.code, imported.stderr).toBe(0);
    expect(JSON.parse(imported.stdout)).toMatchObject({ scanned: 1, created: 1, rejected: 0 });
    const { hits } = await tool<{ hits: Array<Hit & { title: string }> }>(clients.agent, 'brain_search', { query: 'thumbnail queue concurrency' });
    expect(hits[0]).toMatchObject({ title: 'Thumbnail queue', namespace: 'repo:web-app' });

    const reindexed = await owner(['reindex']);
    expect(reindexed.code, reindexed.stderr).toBe(0);
    expect(JSON.parse(reindexed.stdout)).toMatchObject({ state: 'done', error: null });
    expect((await tool<{ hits: Hit[] }>(clients.agent, 'brain_search', { query: 'thumbnail queue concurrency' })).hits[0].slug).toBe(hits[0].slug);

    const retired = await owner(['forget-source', 'claude-memory', '--reason', 'e2e cleanup']);
    expect(JSON.parse(retired.stdout)).toEqual({ forgotten: 1 });
    expect((await tool<{ hits: Hit[] }>(clients.agent, 'brain_search', { query: 'thumbnail queue concurrency' })).hits.map((h) => h.slug)).not.toContain(hits[0].slug);
  });

  it('keeps secrets out: a secret-shaped note or query is refused by name, and nothing reaches the log', async () => {
    const secret = `ghp_${'s'.repeat(30)}`;
    expect(await toolError(clients.agent, 'brain_note', { title: 'Token', body: `the deploy token is ${secret}`, kind: 'memory' })).toMatch(/secret-shaped value: github-token/u);
    expect(await toolError(clients.agent, 'brain_search', { query: `find ${secret}` })).toMatch(/secret-shaped value/u);
    for (const key of Object.values(keys)) {
      expect(server.logs()).not.toContain(key);
    }
    expect(server.logs()).not.toContain(secret);
    expect(server.logs()).not.toContain('bakes the release candidate');
  });
});
