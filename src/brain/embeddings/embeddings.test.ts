import { describe, expect, it } from 'vitest';

import { loadBrainConfig } from '../config.js';
import { createEmbedder, createFakeEmbedder, createGeminiEmbedder, createOpenAiEmbedder, normalize } from './index.js';
import { geminiClient } from './gemini.js';
import { prefixedDocumentInput, prefixedQueryInput, postJson } from './types.js';

const dot = (a: Float32Array, b: Float32Array): number => a.reduce((sum, value, i) => sum + value * b[i], 0);
const FAKE_KEY = 'test-only-not-a-real-key';

/** A fetch that records each request and answers from `reply`. */
function recordingFetch(reply: (body: Record<string, unknown>, attempt: number) => Response) {
  const calls: Array<{ url: string; headers: Record<string, string>; body: Record<string, unknown> }> = [];
  const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    calls.push({ url: String(url), headers: init?.headers as Record<string, string>, body });
    return reply(body, calls.length);
  }) as typeof fetch;
  return { calls, fetchImpl };
}
const json = (value: unknown, status = 200): Response => new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } });

describe('embeddings', () => {
  it('formats inputs with Gemini task prefixes', () => {
    expect(prefixedDocumentInput({ title: 'T', tags: ['a', 'b'], text: 'body' })).toBe('title: T | text: a b\n\nbody');
    expect(prefixedDocumentInput({ title: 'T', tags: [], text: 'body' })).toBe('title: T | text: \n\nbody');
    expect(prefixedQueryInput('what port')).toBe('task: search result | query: what port');
  });

  it('normalizes to unit length and tolerates the zero vector', () => {
    expect(dot(normalize(Float32Array.from([3, 4])), normalize(Float32Array.from([3, 4])))).toBeCloseTo(1, 5);
    expect(Array.from(normalize(Float32Array.from([0, 0])))).toEqual([0, 0]);
  });

  it('fake embedder is deterministic and similarity-preserving', async () => {
    const embedder = createFakeEmbedder(32);
    const [a, b, c] = await embedder.embedDocuments(['pnpm install monorepo', 'pnpm install monorepo', 'speaker volume kitchen']);
    expect(Array.from(a)).toEqual(Array.from(b));
    expect(dot(a, c)).toBeLessThan(dot(a, b));
    expect((await embedder.embedQuery('pnpm monorepo')).length).toBe(32);
  });

  it('gemini embedder batches, normalizes, and checks dims via the injected client', async () => {
    const calls: Array<{ contents: string[]; dims: number; purpose?: string }> = [];
    const client = {
      embed: async (contents: string[], dims: number, purpose?: string) => {
        calls.push({ contents, dims, purpose });
        return contents.map((_, i) => Float32Array.from(Array.from({ length: dims }, (__, j) => (i + 1) * (j + 1))));
      },
    };
    const embedder = createGeminiEmbedder({ apiKey: FAKE_KEY, model: 'gemini-embedding-2', dims: 4, batchSize: 2, client });
    const out = await embedder.embedDocuments(['a', 'b', 'c']);
    expect(calls.map((call) => call.contents.length)).toEqual([2, 1]);
    expect(calls[0]).toMatchObject({ dims: 4, purpose: 'documents' });
    expect(out).toHaveLength(3);
    expect(dot(out[0], out[0])).toBeCloseTo(1, 5);
    expect((await embedder.embedQuery('q')).length).toBe(4);
    expect(calls.at(-1)?.purpose).toBe('query');

    const shortClient = { embed: async (contents: string[]) => contents.map(() => Float32Array.from([1, 2, 3, 4])) };
    const wrong = createGeminiEmbedder({ apiKey: FAKE_KEY, model: 'm', dims: 8, client: shortClient });
    await expect(wrong.embedDocuments(['a'])).rejects.toThrow(/expected 8/u);
  });

  it('gemini client sends one request per input to batchEmbedContents, with the key in a header and never in the URL', async () => {
    const { calls, fetchImpl } = recordingFetch((body) => json({ embeddings: (body.requests as unknown[]).map(() => ({ values: [3, 4] })) }));
    const embedder = createGeminiEmbedder({ apiKey: FAKE_KEY, model: 'models/gemini-embedding-2', dims: 2, fetchImpl });
    const out = await embedder.embedDocuments(['chunk one', 'chunk two', 'chunk three']);
    expect(out).toHaveLength(3);
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe('https://generativelanguage.googleapis.com/v1beta/models/gemini-embedding-2:batchEmbedContents');
    expect(calls[0].url).not.toContain(FAKE_KEY);
    expect(calls[0].headers['x-goog-api-key']).toBe(FAKE_KEY);
    expect(calls[0].body).toEqual({
      requests: ['chunk one', 'chunk two', 'chunk three'].map((text) => ({ model: 'models/gemini-embedding-2', content: { parts: [{ text }] }, outputDimensionality: 2 })),
    });
  });

  it('gemini client refuses a reply whose vector count does not match the inputs', async () => {
    const { fetchImpl } = recordingFetch(() => json({ embeddings: [{ values: [3, 4] }] }));
    const embedder = createGeminiEmbedder({ apiKey: FAKE_KEY, model: 'gemini-embedding-2', dims: 2, fetchImpl });
    await expect(embedder.embedDocuments(['a', 'b'])).rejects.toThrow('Gemini returned 1 embeddings for 2 inputs');
  });

  it('retries throttling and network errors for documents, never for a query, and reports the provider\'s message without the key', async () => {
    // A zero-delay retry schedule keeps the test fast; documents really wait 0.5 s and 2 s.
    const throttled = recordingFetch((_body, attempt) => (attempt === 1 ? json({ error: { message: 'Resource exhausted' } }, 429) : json({ ok: true })));
    expect(await postJson({ provider: 'Gemini', url: 'https://example.invalid/x', headers: {}, body: {}, timeoutMs: 1000, fetchImpl: throttled.fetchImpl, retryDelaysMs: [0] })).toEqual({ ok: true });
    expect(throttled.calls).toHaveLength(2);
    let attempts = 0;
    const flaky = (async () => { attempts += 1; if (attempts === 1) { throw new TypeError('fetch failed'); } return json({ ok: true }); }) as typeof fetch;
    expect(await postJson({ provider: 'Gemini', url: 'https://example.invalid/x', headers: {}, body: {}, timeoutMs: 1000, fetchImpl: flaky, retryDelaysMs: [0] })).toEqual({ ok: true });
    expect(attempts).toBe(2);

    const down = recordingFetch(() => json({}, 503));
    await expect(geminiClient({ apiKey: FAKE_KEY, model: 'm', fetchImpl: down.fetchImpl }).embed(['x'], 2, 'query')).rejects.toThrow(/failed with 503/u);
    expect(down.calls).toHaveLength(1);

    const failing = recordingFetch(() => json({ error: { message: 'API key not valid' } }, 400));
    const error = await geminiClient({ apiKey: FAKE_KEY, model: 'gemini-embedding-2', fetchImpl: failing.fetchImpl }).embed(['x'], 2, 'documents').catch((e: Error) => e);
    expect(String(error)).toContain('Gemini embedding request failed with 400: API key not valid');
    expect(String(error)).not.toContain(FAKE_KEY);
    expect(failing.calls).toHaveLength(1);
  });

  it('openai-compatible embedder posts to {base}/embeddings, sends dimensions only to models that take it, and orders by index', async () => {
    const { calls, fetchImpl } = recordingFetch((body) => json({ data: (body.input as string[]).map((_, index) => ({ index, embedding: [index + 1, 0, 0] })).reverse() }));
    const openai = createOpenAiEmbedder({ apiKey: FAKE_KEY, model: 'text-embedding-3-small', dims: 3, baseUrl: 'https://api.openai.com/v1/', fetchImpl });
    const out = await openai.embedDocuments(['first', 'second']);
    expect(calls[0].url).toBe('https://api.openai.com/v1/embeddings');
    expect(calls[0].headers.authorization).toBe(`Bearer ${FAKE_KEY}`);
    expect(calls[0].body).toEqual({ model: 'text-embedding-3-small', input: ['first', 'second'], encoding_format: 'float', dimensions: 3 });
    expect(Array.from(out[0])).toEqual([1, 0, 0]);
    expect(Array.from(out[1])).toEqual([1, 0, 0]);
    expect(openai.documentInput({ title: 'T', tags: ['a'], text: 'body' })).toBe('T\na\n\nbody');
    expect(openai.queryInput('raw query')).toBe('raw query');

    const local = createOpenAiEmbedder({ model: 'nomic-embed-text', dims: 3, baseUrl: 'http://127.0.0.1:11434/v1', fetchImpl });
    await local.embedQuery('q');
    expect(calls[1].body).toEqual({ model: 'nomic-embed-text', input: ['q'], encoding_format: 'float' });
    expect(calls[1].headers.authorization).toBeUndefined();
  });

  it('creates the configured provider and names a missing key without a value', () => {
    expect(createEmbedder(loadBrainConfig({ BRAIN_EMBED_PROVIDER: 'fake', BRAIN_EMBED_DIMS: '16' })).dims).toBe(16);
    expect(() => createEmbedder(loadBrainConfig({}), {})).toThrow(/GEMINI_API_KEY \(or GOOGLE_API_KEY\) is not set/u);
    expect(createEmbedder(loadBrainConfig({}), { GOOGLE_API_KEY: FAKE_KEY }).model).toBe('gemini-embedding-2');
    expect(() => createEmbedder(loadBrainConfig({ BRAIN_EMBED_PROVIDER: 'openai' }), {})).toThrow(/OPENAI_API_KEY/u);
    expect(createEmbedder(loadBrainConfig({ BRAIN_EMBED_PROVIDER: 'openai', BRAIN_EMBED_BASE_URL: 'http://127.0.0.1:11434/v1', BRAIN_EMBED_MODEL: 'nomic-embed-text', BRAIN_EMBED_DIMS: '768' }), {}).dims).toBe(768);
  });
});
