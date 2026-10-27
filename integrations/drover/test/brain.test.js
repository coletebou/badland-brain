// The Drover plugin against a fake MCP server on loopback: no network, no real key. Like badland-brain the fake is
// stateless and answers JSON (SSE and a stateful session are variants), and like a CDN's browser check in front of a
// server, any request without the plugin's User-Agent gets HTTP 403 error 1010.
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterAll, beforeAll, beforeEach, describe, test } from 'vitest';

import * as brain from '../brain.js';
import { parseMcpBody } from '../mcp-body.js';
import plugin from '../plugin.js';

const { ops, _deps, USER_AGENT, DEFAULT_URL } = brain;
const KEY = 'EXAMPLE_brain_key_not_a_real_one';
const HASH = 'a'.repeat(64), NEWER = 'b'.repeat(64);
const READ = { readOnlyHint: true }, WRITE = { readOnlyHint: false };
const ok = (data) => ({ content: [{ type: 'text', text: JSON.stringify(data) }], structuredContent: data });
const TOOLS = {
  brain_context: { annotations: READ, run: (a) => ok({ standing: ['The team ships from main'], decisions: [], namespace: a.namespace ?? null }) },
  brain_search: { annotations: READ, run: (a) => ok({ hits: [{ slug: 'breaker-timeout', title: 'Breaker timeout', kind: 'decision', args: a }] }) },
  brain_get: { annotations: READ, run: (a) => ok({ slug: a.slug, body: 'the body', contentHash: HASH, offset: a.offset ?? 0, hasMore: false, history: [] }) },
  brain_list: { annotations: READ, run: () => ok({ items: [], page: 1, limit: 20, hasMore: false }) },
  brain_note: { annotations: WRITE, run: (a) => ok({ entry: { slug: 'new-note' }, created: true, args: a }) },
  brain_supersede: { annotations: WRITE, run: (a) => (a.expectedHash === HASH ? ok({ slug: a.slug, contentHash: NEWER }) : { content: [{ type: 'text', text: JSON.stringify({ error: `The entry changed since you read it. Current contentHash: ${HASH}. Re-read it, then retry.`, code: 'conflict' }) }], isError: true }) },
  brain_forget: { annotations: { readOnlyHint: false, destructiveHint: true }, run: () => ok({ forgotten: 1 }) },
  // Text only, no structuredContent: the client parses the text block.
  notes_search: { annotations: READ, run: (a) => ({ content: [{ type: 'text', text: JSON.stringify({ notes: [{ id: 'n1', title: 'garden' }], query: a.query }) }] }) },
};

/**
 * A fake brain at /mcp (and /healthz). sse: answer as event streams. sessionId: hand out mcp-session-id at initialize
 * and want it back (400 without, 404 once expired). readOnlyKey: no write tools. fail: answer every POST with this
 * {status, body}. silent: never answer. delayMs: answer each request this late, noting when the client gives up first.
 */
async function fakeBrain({ sse = false, sessionId = null, readOnlyKey = false, health = 200, fail = null, silent = false, delayMs = 0 } = {}) {
  const calls = [], expired = new Set();
  let issued = 0;
  const tools = Object.fromEntries(Object.entries(TOOLS).filter(([, t]) => !readOnlyKey || t.annotations.readOnlyHint));
  const server = createServer((req, res) => {
    let raw = '';
    req.on('data', (d) => { raw += d; });
    req.on('end', () => {
      if (silent) { const c = { method: req.method, url: req.url, closed: false }; calls.push(c); res.on('close', () => { c.closed = true; }); return; }
      const msg = raw ? JSON.parse(raw) : null;
      const call = { method: req.method, url: req.url, headers: req.headers, msg, closed: false };
      calls.push(call);
      if (delayMs) { res.on('close', () => { if (!res.writableEnded) call.closed = true; }); setTimeout(() => { if (!call.closed) answer(); }, delayMs); return; }
      answer();
      function answer() {
        const send = (status, body, headers = {}) => { res.writeHead(status, { 'content-type': 'application/json', ...headers }); res.end(typeof body === 'string' ? body : JSON.stringify(body)); };
        if (req.headers['user-agent'] !== USER_AGENT) return send(403, { title: 'Error 1010: Access denied', status: 403, error_code: 1010, error_name: 'browser_signature_banned' });
        if (req.method === 'GET' && req.url === '/healthz') return health === 200 ? send(200, { ok: true, stale: false, entries: 42, chunks: 99, model: 'gemini-embedding-2', dims: 1536 }) : send(health, { ok: false, reason: 'brain_unavailable' });
        if (req.method !== 'POST' || req.url !== '/mcp') return send(405, { error: 'method_not_allowed' });
        if (fail) return send(fail.status, fail.body);
        if (req.headers.authorization !== `Bearer ${KEY}`) return send(401, { ok: false, error: 'A valid bearer key is required.' });
        const sid = sessionId && msg.method === 'initialize' ? `${sessionId}-${++issued}` : null;
        const reply = (payload) => {
          const body = { jsonrpc: '2.0', id: msg.id, ...payload };
          const h = sid ? { 'mcp-session-id': sid } : {};
          if (!sse) return send(200, body, h);
          res.writeHead(200, { 'content-type': 'text/event-stream', ...h });
          res.end(`event: message\ndata: ${JSON.stringify(body)}\n\n`);
        };
        if (msg.method === 'initialize') return reply({ result: { protocolVersion: '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'badland-brain', version: '0.1.0' } } });
        if (sessionId) {
          const have = req.headers['mcp-session-id'];
          if (!have) return send(400, { jsonrpc: '2.0', id: null, error: { code: -32000, message: 'Bad Request: No valid session ID provided' } });
          if (expired.has(have)) return send(404, { jsonrpc: '2.0', id: null, error: { code: -32001, message: 'Session not found' } });
        }
        if (msg.id === undefined) { res.writeHead(202); return res.end(); }
        if (msg.method === 'tools/list') return reply({ result: { tools: Object.entries(tools).map(([name, t]) => ({ name, inputSchema: { type: 'object' }, annotations: t.annotations })) } });
        if (msg.method === 'tools/call') {
          const t = tools[msg.params.name];
          if (!t) return reply({ error: { code: -32602, message: `MCP error -32602: Tool ${msg.params.name} not found` } });
          return reply({ result: t.run(msg.params.arguments ?? {}) });
        }
        reply({ error: { code: -32601, message: 'Method not found' } });
      }
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return {
    url: `http://127.0.0.1:${server.address().port}`, calls,
    posts: () => calls.filter((c) => c.method === 'POST'),
    expire: (id) => expired.add(id),
    close: () => new Promise((r) => { server.closeAllConnections(); server.close(r); }),
  };
}

let dir, fake;
const use = (f, env = {}) => { _deps.env = { BRAIN_URL: f.url, BRAIN_KEY: KEY, ...env }; };
beforeAll(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'drover-brain-'));
  fake = await fakeBrain();
});
beforeEach(() => { brain.resetSession(); _deps.timeoutMs = 30_000; });
afterAll(async () => { await fake.close(); await rm(dir, { recursive: true, force: true }); _deps.env = process.env; });

describe('key and URL', () => {
  test('the key comes from the environment, else from BRAIN_KEY_FILE: a bare key, or its own line of a dotenv file (the last one)', async () => {
    const f = path.join(dir, 'key-file');
    await writeFile(f, 'export OTHER_SECRET=not-loaded\nBRAIN_KEY="first"\n# export BRAIN_KEY=commented\nexport BRAIN_KEY=\'second\'\nNOT_THIS=1\n');
    const env = { BRAIN_KEY_FILE: f };
    assert.deepEqual(await brain.brainKey(env), { key: 'second', source: 'key-file' });
    assert.equal(env.OTHER_SECRET, undefined); assert.equal(process.env.OTHER_SECRET, undefined);
    await writeFile(f, 'export BRAIN_KEY=abc123 # rotated\r\n');
    assert.deepEqual(await brain.brainKey(env), { key: 'abc123', source: 'key-file' });
    // A quoted value ends at its closing quote, with an inline comment after it.
    await writeFile(f, 'BRAIN_KEY="quoted-key" # the agent key\n');
    assert.deepEqual(await brain.brainKey(env), { key: 'quoted-key', source: 'key-file' });
    await writeFile(f, "export BRAIN_KEY='single-quoted'   # rotated\n");
    assert.deepEqual(await brain.brainKey(env), { key: 'single-quoted', source: 'key-file' });
    await writeFile(f, '  a-bare-key-value  \n');
    assert.deepEqual(await brain.brainKey(env), { key: 'a-bare-key-value', source: 'key-file' });
    await writeFile(f, 'OTHER_KEY=not-the-brain-key\n');
    assert.deepEqual(await brain.brainKey(env), { key: null, source: null });
    assert.deepEqual(await brain.brainKey({ ...env, BRAIN_KEY: ' from-env ' }), { key: 'from-env', source: 'env' });
    assert.deepEqual(await brain.brainKey({ BRAIN_KEY_FILE: path.join(dir, 'missing') }), { key: null, source: null });
    assert.deepEqual(await brain.brainKey({}), { key: null, source: null });
  });
  test('https only, or plain http to loopback; a trailing slash is dropped; no default remote endpoint', () => {
    assert.equal(brain.brainUrl({}), DEFAULT_URL);
    assert.match(DEFAULT_URL, /^http:\/\/127\.0\.0\.1:/);
    assert.equal(brain.brainUrl({ BRAIN_URL: 'http://127.0.0.1:9/' }), 'http://127.0.0.1:9');
    assert.equal(brain.brainUrl({ BRAIN_URL: 'https://brain.example/prefix/' }), 'https://brain.example/prefix');
    assert.equal(brain.mcpUrl({ BRAIN_URL: 'https://brain.example/prefix/' }), 'https://brain.example/prefix/mcp');
    assert.throws(() => brain.brainUrl({ BRAIN_URL: 'http://brain.example' }), /must be https .*in clear/);
    assert.throws(() => brain.brainUrl({ BRAIN_URL: 'https://brain.example/?x=1' }), /without a query/);
    assert.throws(() => brain.brainUrl({ BRAIN_URL: 'not a url' }), /not a URL/);
  });
  test('parses JSON, JSON arrays and event-stream bodies', () => {
    assert.deepEqual(parseMcpBody('application/json', '{"id":1}'), [{ id: 1 }]);
    assert.deepEqual(parseMcpBody('application/json', '[{"id":1},{"id":2}]'), [{ id: 1 }, { id: 2 }]);
    assert.deepEqual(parseMcpBody('text/event-stream', ': keep-alive\n\nevent: message\ndata: {"id":3}\n\ndata: not json\n\n'), [{ id: 3 }]);
    assert.deepEqual(parseMcpBody(null, 'data: {"id":4}\n\n'), [{ id: 4 }]);
    assert.deepEqual(parseMcpBody('application/json', '  '), []);
  });
});

describe('talking to the server', () => {
  test('status without a key: the health check only (no key sent anywhere) and how to add one', async () => {
    use(fake, { BRAIN_KEY: undefined });
    const before = fake.calls.length;
    const r = await ops['brain.status']();
    assert.equal(r.keyConfigured, false); assert.equal(r.keySource, null);
    assert.deepEqual(r.health, { status: 200, ok: true, stale: false, entries: 42, chunks: 99, model: 'gemini-embedding-2', dims: 1536 });
    assert.match(r.hint, /BRAIN_KEY/);
    const mine = fake.calls.slice(before);
    assert.deepEqual(mine.map((c) => `${c.method} ${c.url}`), ['GET /healthz']);
    assert.equal(mine[0].headers.authorization, undefined); assert.equal(mine[0].headers['user-agent'], USER_AGENT);
  });
  test('status with a key: initialize, notifications/initialized, then the tools the key can call', async () => {
    use(fake);
    const before = fake.posts().length;
    const r = await ops['brain.status']();
    assert.equal(r.keyConfigured, true); assert.equal(r.keySource, 'env');
    assert.deepEqual(r.tools, Object.keys(TOOLS));
    assert.equal(r.write, true); assert.equal(r.protocol, '2025-06-18'); assert.equal(r.session, 'none (stateless server)');
    assert.deepEqual(fake.posts().slice(before).map((c) => c.msg.method), ['initialize', 'notifications/initialized', 'tools/list']);
  });
  test('every request carries the key, accepts JSON and SSE and names its User-Agent; the protocol version follows initialize; the session is reused', async () => {
    use(fake);
    const before = fake.posts().length;
    const r = await ops['brain.search']({ query: ' breaker timeout ', limit: 50, kinds: ['decision'], namespace: 'repo:example' });
    assert.deepEqual(r.hits[0].args, { query: 'breaker timeout', topK: 10, kinds: ['decision'], namespace: 'repo:example' }, 'limit becomes topK, capped at the server\'s 10');
    const mine = fake.posts().slice(before);
    assert.deepEqual(mine.map((c) => c.msg.method), ['initialize', 'notifications/initialized', 'tools/call']);
    for (const c of mine) {
      assert.equal(c.url, '/mcp');
      assert.equal(c.headers.authorization, `Bearer ${KEY}`);
      assert.equal(c.headers.accept, 'application/json, text/event-stream');
      assert.equal(c.headers['content-type'], 'application/json');
      assert.equal(c.headers['user-agent'], USER_AGENT);
    }
    assert.equal(mine[0].headers['mcp-protocol-version'], undefined);
    assert.equal(mine[1].headers['mcp-protocol-version'], '2025-06-18'); assert.equal(mine[1].msg.id, undefined, 'a notification has no id');
    assert.equal(mine[2].msg.params.name, 'brain_search');
    await ops['brain.search']({ query: 'again' });
    assert.deepEqual(fake.posts().slice(before + 3).map((c) => c.msg.method), ['tools/call'], 'no second initialize');
    assert.equal(fake.posts().at(-1).msg.params.arguments.topK, undefined, 'no limit, the server default');
  });
  test('context, get, note and supersede pass only the arguments given; bad input is refused before anything is sent', async () => {
    use(fake);
    assert.equal((await ops['brain.context']({ namespace: 'repo:example' })).namespace, 'repo:example');
    assert.equal((await ops['brain.get']({ slug: 'breaker-timeout' })).contentHash, HASH);
    const note = await ops['brain.note']({ title: ' Breaker ', body: 'Five seconds.', kind: 'decision', tags: ['breaker'], namespace: 'repo:example', importance: 7, actor: 'mcp' });
    assert.deepEqual(note.args, { title: 'Breaker', body: 'Five seconds.', kind: 'decision', tags: ['breaker'], namespace: 'repo:example', importance: 7 }, 'no actor or empty fields reach the brain');
    assert.equal((await ops['brain.supersede']({ slug: 'breaker-timeout', body: 'Ten seconds.', reason: 'raised', expectedHash: HASH })).contentHash, NEWER);
    const sent = fake.posts().length;
    await assert.rejects(ops['brain.note']({ title: 'T', body: 'B', kind: 'reference' }), /kind must be one of memory, decision, handoff, doc/);
    await assert.rejects(ops['brain.note']({ title: 'T', kind: 'memory' }), /body must be a non-empty string/);
    await assert.rejects(ops['brain.supersede']({ slug: 's', body: 'b', reason: 'r' }), /expectedHash/);
    await assert.rejects(ops['brain.search']({ query: 'x', tier: 'gold' }), /tier must be one of/);
    await assert.rejects(ops['brain.search']({ query: '   ' }), /query must be a non-empty string/);
    assert.equal(fake.posts().length, sent);
  });
  test('a tool error is the server\'s own sentence with its code (a stale hash names the current one)', async () => {
    use(fake);
    await assert.rejects(ops['brain.supersede']({ slug: 'breaker-timeout', body: 'b', reason: 'r', expectedHash: NEWER }), /^BrainError: brain_supersede: The entry changed since you read it\. Current contentHash: a{64}\. Re-read it, then retry\. \(conflict\)$/);
  });
  test('brain.call runs a read-only tool by name and refuses writes and unknown tools without calling them', async () => {
    use(fake);
    assert.deepEqual(await ops['brain.call']({ tool: 'notes_search', args: { query: 'garden' } }), { notes: [{ id: 'n1', title: 'garden' }], query: 'garden' });
    assert.deepEqual(await ops['brain.call']({ tool: 'brain_list' }), { items: [], page: 1, limit: 20, hasMore: false });
    await assert.rejects(ops['brain.call']({ tool: 'brain_forget', args: { slug: 'x', reason: 'y' } }), /brain_forget is not read-only/);
    await assert.rejects(ops['brain.call']({ tool: 'brain_note', args: { title: 't' } }), /brain_note is not read-only/);
    await assert.rejects(ops['brain.call']({ tool: 'delete_everything' }), /has no tool delete_everything/);
    await assert.rejects(ops['brain.call']({ tool: 'brain_list', args: ['x'] }), /args must be an object/);
    const called = fake.posts().filter((c) => c.msg.method === 'tools/call').map((c) => c.msg.params.name);
    assert.ok(!called.includes('brain_forget') && !called.includes('delete_everything'));
  });
  test('a rotated key starts a new session, and brain.call checks its tools against the new key\'s list', async () => {
    const ro = await fakeBrain({ readOnlyKey: true });
    try {
      use(ro);
      assert.ok((await ops['brain.call']({ tool: 'brain_list' })).items);
      const before = ro.posts().length;
      use(ro, { BRAIN_KEY: 'EXAMPLE_rotated_key' });
      await assert.rejects(ops['brain.call']({ tool: 'brain_list' }), /HTTP 401/);
      assert.equal(ro.posts()[before].msg.method, 'initialize', 'the new key starts with initialize, not the old session\'s cached list');
    } finally { await ro.close(); }
  });
  test('a read-only key: the write tool is missing on the server, and the message says where to look', async () => {
    const ro = await fakeBrain({ readOnlyKey: true });
    try {
      use(ro);
      await assert.rejects(ops['brain.note']({ title: 'T', body: 'B', kind: 'memory' }), /Tool brain_note not found; brain\.status lists the tools this key can call/);
      assert.equal((await ops['brain.status']()).write, false);
    } finally { await ro.close(); }
  });
  test('SSE bodies are read the same as JSON', async () => {
    const s = await fakeBrain({ sse: true });
    try {
      use(s);
      assert.equal((await ops['brain.search']({ query: 'breaker' })).hits[0].slug, 'breaker-timeout');
      assert.equal((await ops['brain.status']()).tools.length, Object.keys(TOOLS).length);
    } finally { await s.close(); }
  });
  test('a stateful server: its mcp-session-id goes back on every request, and an expired session is started again once', async () => {
    const s = await fakeBrain({ sessionId: 'sess' });
    try {
      use(s);
      await ops['brain.search']({ query: 'one' });
      assert.deepEqual(s.posts().map((c) => [c.msg.method, c.headers['mcp-session-id'] ?? null]), [['initialize', null], ['notifications/initialized', 'sess-1'], ['tools/call', 'sess-1']]);
      s.expire('sess-1');
      assert.equal((await ops['brain.search']({ query: 'two' })).hits[0].args.query, 'two');
      assert.deepEqual(s.posts().slice(3).map((c) => [c.msg.method, c.headers['mcp-session-id'] ?? null]), [['tools/call', 'sess-1'], ['initialize', null], ['notifications/initialized', 'sess-2'], ['tools/call', 'sess-2']]);
    } finally { await s.close(); }
  });
});

describe('errors say what to fix, never with the key', () => {
  const noKey = (e) => { assert.ok(!String(e.message).includes(KEY), e.message); return true; };
  test('401, 403, 429, 503, 413 and others', async () => {
    use(fake, { BRAIN_KEY: 'EXAMPLE_wrong_key' });
    await assert.rejects(ops['brain.search']({ query: 'x' }), (e) => /the brain rejected BRAIN_KEY \(HTTP 401: A valid bearer key is required\.\); set a current key/.test(e.message) && !e.message.includes('EXAMPLE_wrong_key'));
    for (const [fail, re] of [
      [{ status: 403, body: { ok: false, error: 'A owner key cannot use this route.' } }, /refused BRAIN_KEY \(HTTP 403: A owner key cannot use this route\.\); the MCP endpoint takes read or agent keys/],
      [{ status: 429, body: { ok: false, error: 'Too many requests for this key; slow down.' } }, /rate-limiting this key \(HTTP 429/],
      [{ status: 503, body: { error: 'brain_unavailable' } }, /the brain is unavailable \(HTTP 503 brain_unavailable\)/],
      [{ status: 413, body: { error: 'payload_too_large' } }, /too large \(HTTP 413/],
      [{ status: 500, body: '<html>oops</html>' }, /brain HTTP 500: <html>oops<\/html>/],
    ]) {
      const f = await fakeBrain({ fail });
      try { brain.resetSession(); use(f); await assert.rejects(ops['brain.search']({ query: 'x' }), (e) => re.test(e.message) && noKey(e)); } finally { await f.close(); }
    }
  });
  test('a CDN browser check (403, error 1010) is named, as JSON or as an HTML page', async () => {
    const page = '<!doctype html><title>Access denied | brain.example used Cloudflare to restrict access</title><span>1010</span><a href="https://developers.cloudflare.com/support/troubleshooting/http-status-codes/cloudflare-1xxx-errors/error-1010/">docs</a><script>a={event:"feedback clicked",properties:{errorCode: 1010 }}</script>';
    for (const body of [{ title: 'Error 1010: Access denied', status: 403, error_code: 1010, error_name: 'browser_signature_banned' }, page, page.replace(/errorCode: 1010 /, ''), page.replace(/error-1010\//g, '')]) {
      const f = await fakeBrain({ fail: { status: 403, body } });
      try { brain.resetSession(); use(f); await assert.rejects(ops['brain.context']({}), (e) => /blocked by the CDN's browser check .*error 1010, browser_signature_banned.*badland-brain-drover\/1/.test(e.message) && e.cloudflare === 1010 && noKey(e)); } finally { await f.close(); }
    }
    const waf = await fakeBrain({ fail: { status: 403, body: { error_code: 1020, error_name: 'access_denied' } } });
    try { brain.resetSession(); use(waf); await assert.rejects(ops['brain.context']({}), /blocked by the CDN in front of the brain \(HTTP 403, error 1020 access_denied\)/); } finally { await waf.close(); }
  });
  test('no key anywhere: a sentence, and nothing is sent', async () => {
    use(fake, { BRAIN_KEY: undefined });
    const sent = fake.posts().length;
    await assert.rejects(ops['brain.search']({ query: 'x' }), /BRAIN_KEY is not set: not in the environment, and no key in the file BRAIN_KEY_FILE names/);
    assert.equal(fake.posts().length, sent);
  });
  test('a server that is down or silent; status reports it instead of throwing', async () => {
    const gone = await fakeBrain();
    await gone.close();
    use(gone);
    // Usually refused; under some virtualized networking a closed localhost port accepts the connection and then resets it.
    await assert.rejects(ops['brain.search']({ query: 'x' }), /the brain at 127\.0\.0\.1:\d+ is unreachable: (ECONNREFUSED|ECONNRESET)/);
    const st = await ops['brain.status']();
    assert.equal(st.health.ok, false); assert.match(st.health.error, /unreachable/); assert.match(st.error, /unreachable/);
    const quiet = await fakeBrain({ silent: true });
    try {
      brain.resetSession(); use(quiet); _deps.timeoutMs = 300;
      await assert.rejects(ops['brain.search']({ query: 'x' }), /did not answer within 0 s/);
    } finally { await quiet.close(); }
    const sick = await fakeBrain({ health: 503 });
    try { use(sick); const h = (await ops['brain.status']()).health; assert.equal(h.ok, false); assert.equal(h.reason, 'brain_unavailable'); assert.match(h.error, /HTTP 503/); } finally { await sick.close(); }
  });
});

describe('search kind brain (Drover\'s search asks the brain at query time)', () => {
  const HIT = { slug: 'bot-gateway-each-bot-at-its-own-url-61f638', title: 'Bot gateway: each bot at its own URL', kind: 'decision', tier: 'episodic', namespace: 'repo:example', originClass: 'agent', authorAgent: 'agent@laptop', importance: 5, validFrom: '2026-10-20T20:16:40.798Z', updatedAt: '2026-10-20T20:16:40.815Z', startLine: 1, endLine: 10, snippet: 'Bots reach the service through its gateway.\n\n- Connected as themselves…', score: 0.8428, similarity: 0.6343, vecRank: 2, textRank: 6 };
  const MAPPED = { title: HIT.title, snippet: HIT.snippet, ts: '2026-10-20T20:16:40.798Z', slug: HIT.slug, namespace: 'repo:example', tier: 'episodic', author: 'agent@laptop', role: 'decision', score: 0.8428 };
  const realSearch = TOOLS.brain_search.run;
  const answerWith = (hits) => { TOOLS.brain_search.run = (a) => ok({ hits, args: a }); };
  let seen;
  beforeEach(() => { seen = fake.posts().length; });
  afterAll(() => { TOOLS.brain_search.run = realSearch; });

  test('searchHit maps a brain_search hit to the search hit fields, nothing else; ts is validFrom, else updatedAt', () => {
    assert.deepEqual(brain.searchHit(HIT), MAPPED);
    const { validFrom, ...noValidFrom } = HIT;
    assert.equal(validFrom, HIT.validFrom);
    assert.equal(brain.searchHit(noValidFrom).ts, '2026-10-20T20:16:40.815Z');
    assert.deepEqual(brain.searchHit({}), { title: null, snippet: '', ts: null, slug: null, namespace: null, tier: null, author: null, role: null, score: null });
  });
  test('the source sends brain_search at most 300 characters and asks for at most 10 hits', async () => {
    use(fake); answerWith([HIT]);
    const r = await brain.SEARCH.remote.brain({ query: `${'x'.repeat(299)}\u{1F600}tail`, limit: 50, kinds: ['brain'], days: 7, project: 'example' });
    assert.deepEqual(r, { hits: [MAPPED] });
    const call = fake.posts().slice(seen).find((c) => c.msg.method === 'tools/call');
    assert.equal(call.msg.params.name, 'brain_search');
    assert.deepEqual(call.msg.params.arguments, { query: 'x'.repeat(299), topK: 10 }, 'cut at 300 without half an emoji; Drover\'s own kinds, days and project are not the brain\'s');
    await brain.SEARCH.remote.brain({ query: 'q', limit: 3 });
    assert.equal(fake.posts().at(-1).msg.params.arguments.topK, 3);
  });
  /** Wait (up to 3 s) until check() is true. */
  const until = async (check) => { const end = Date.now() + 3000; while (!check()) { if (Date.now() > end) throw new Error('timed out waiting'); await new Promise((r) => setTimeout(r, 10)); } };
  test('a search that stops waiting stops the request at once, not at the transport\'s 30 s timeout', async () => {
    const quiet = await fakeBrain({ silent: true });
    try {
      brain.resetSession(); use(quiet);
      const stop = new AbortController();
      const p = brain.SEARCH.remote.brain({ query: 'x', signal: stop.signal });
      await until(() => quiet.calls.length === 1);
      const t0 = Date.now();
      stop.abort();
      await assert.rejects(p, (e) => e.aborted === true && /was stopped: its caller stopped waiting/.test(e.message));
      assert.ok(Date.now() - t0 < 2000, `stopped ${Date.now() - t0} ms after the abort, not at the transport timeout`);
      await until(() => quiet.calls[0].closed);
    } finally { await quiet.close(); brain.resetSession(); }
  });
  test('a caller that stops waiting during the shared session start never fails another caller waiting for it', async () => {
    const slow = await fakeBrain({ delayMs: 300 });
    try {
      brain.resetSession(); use(slow);
      const stop = new AbortController();
      const gaveUp = brain.SEARCH.remote.brain({ query: 'x', signal: stop.signal });
      const other = ops['brain.context']({});   // no signal: it waits for the same start
      await until(() => slow.calls.length === 1);
      stop.abort();
      await assert.rejects(gaveUp, (e) => e.aborted === true);
      assert.deepEqual((await other).standing, ['The team ships from main']);
      assert.equal(slow.calls[0].closed, false, 'the shared initialize was not stopped');
    } finally { await slow.close(); brain.resetSession(); }
  });
  test('a caller whose signal has already fired starts nothing and sends nothing', async () => {
    const before = fake.posts().length;
    brain.resetSession(); use(fake);
    const stop = new AbortController(); stop.abort();
    await assert.rejects(brain.SEARCH.remote.brain({ query: 'x', signal: stop.signal }), (e) => e.aborted === true);
    assert.equal(fake.posts().length, before, 'no initialize went out');
  });
  test('after a start every caller gave up on, the next call begins a fresh one', async () => {
    const slow = await fakeBrain({ delayMs: 200 });
    try {
      brain.resetSession(); use(slow);
      const stop = new AbortController();
      const gaveUp = brain.SEARCH.remote.brain({ query: 'x', signal: stop.signal });
      await until(() => slow.calls.length === 1);
      stop.abort();
      await assert.rejects(gaveUp, (e) => e.aborted === true);
      assert.deepEqual((await ops['brain.context']({})).standing, ['The team ships from main']);
      const inits = slow.calls.filter((c) => c.msg?.method === 'initialize');
      assert.equal(inits.length, 2, 'a second initialize, not the stopped one');
      assert.equal(inits[0].closed, true);
    } finally { await slow.close(); brain.resetSession(); }
  });
  test('the shared session start is stopped only once every caller waiting for it has stopped', async () => {
    const quiet = await fakeBrain({ silent: true });
    try {
      brain.resetSession(); use(quiet);
      const a = new AbortController(), b = new AbortController();
      const first = brain.SEARCH.remote.brain({ query: 'x', signal: a.signal });
      const second = brain.SEARCH.remote.brain({ query: 'y', signal: b.signal });
      await until(() => quiet.calls.length === 1);
      a.abort();
      await assert.rejects(first, (e) => e.aborted === true);
      await new Promise((r) => setTimeout(r, 100));
      assert.equal(quiet.calls[0].closed, false, 'still started for the second caller');
      b.abort();
      await assert.rejects(second, (e) => e.aborted === true);
      await until(() => quiet.calls[0].closed);
      assert.equal(quiet.calls.length, 1, 'one initialize for both');
    } finally { await quiet.close(); brain.resetSession(); }
  });
});

describe('the plugin, as Drover loads it (web/core/plugins.js)', () => {
  test('has a valid name, an entry in meta for every op with a closed JSON schema, the brain search kind, and instructions', () => {
    assert.match(plugin.name, /^[a-z][a-z0-9-]{0,39}$/);
    assert.deepEqual(Object.keys(plugin.ops).sort(), Object.keys(plugin.meta).sort());
    assert.deepEqual(Object.keys(plugin.ops).sort(), ['brain.call', 'brain.context', 'brain.get', 'brain.note', 'brain.search', 'brain.status', 'brain.supersede']);
    for (const [op, entry] of Object.entries(plugin.meta)) {
      assert.equal(typeof plugin.ops[op], 'function', op);
      assert.equal(typeof entry.m, 'boolean', op);
      assert.ok(typeof entry.d === 'string' && entry.d.length > 20, op);
      assert.equal(entry.s.type, 'object', op);
      assert.equal(entry.s.additionalProperties, false, op);
      assert.ok(entry.s.required.every((name) => name in entry.s.properties), op);
      assert.ok('host' in entry.s.properties, `${op} takes Drover's host argument`);
    }
    assert.deepEqual(Object.entries(plugin.meta).filter(([, e]) => e.m).map(([op]) => op).sort(), ['brain.note', 'brain.supersede'], 'only note and supersede mutate');
    assert.ok(plugin.meta['brain.note'].s.properties.actor && plugin.meta['brain.supersede'].s.properties.actor, 'mutating ops accept the actor Drover adds');
    assert.deepEqual(plugin.meta['brain.note'].s.properties.kind.enum, ['memory', 'decision', 'handoff', 'doc']);
    assert.equal(typeof plugin.search.remote.brain, 'function');
    assert.ok(Array.isArray(plugin.mcpInstructions) && plugin.mcpInstructions.every((line) => typeof line === 'string'));
  });
});
