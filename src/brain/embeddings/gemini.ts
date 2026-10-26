import { EMBED_ATTEMPTS, type EmbedPurpose, type Embedder, batchingEmbedder, postJson, prefixedDocumentInput, prefixedQueryInput } from './types.js';

export const GEMINI_API_BASE = 'https://generativelanguage.googleapis.com';

/** The one call the Gemini embedder needs; injected in tests. */
export interface GeminiLike {
  embed(contents: string[], dims: number, purpose?: EmbedPurpose): Promise<Float32Array[]>;
}

/**
 * The Gemini Developer API's batch endpoint, called directly. Each input is its own request with its own Content, so a
 * multi-chunk document gets one vector per chunk (a single Content with many parts would be embedded as one text). The
 * key travels in the `x-goog-api-key` header, never in the URL.
 */
export function geminiClient(options: { apiKey: string; model: string; baseUrl?: string; fetchImpl?: typeof fetch }): GeminiLike {
  const model = options.model.replace(/^models\//u, '');
  const url = `${(options.baseUrl ?? GEMINI_API_BASE).replace(/\/+$/u, '')}/v1beta/models/${encodeURIComponent(model)}:batchEmbedContents`;
  return {
    async embed(contents, dims, purpose = 'documents') {
      const json = await postJson({
        provider: 'Gemini',
        url,
        headers: { 'x-goog-api-key': options.apiKey },
        body: { requests: contents.map((text) => ({ model: `models/${model}`, content: { parts: [{ text }] }, outputDimensionality: dims })) },
        ...EMBED_ATTEMPTS[purpose],
        fetchImpl: options.fetchImpl,
      }) as { embeddings?: Array<{ values?: number[] }> };
      const list = json.embeddings ?? [];
      if (list.length !== contents.length) {
        throw new Error(`Gemini returned ${list.length} embeddings for ${contents.length} inputs`);
      }
      return list.map((embedding) => Float32Array.from(embedding.values ?? []));
    },
  };
}

export function createGeminiEmbedder(options: {
  apiKey: string;
  model: string;
  dims: number;
  batchSize?: number;
  client?: GeminiLike;
  baseUrl?: string;
  fetchImpl?: typeof fetch;
}): Embedder {
  const client = options.client ?? geminiClient(options);
  return batchingEmbedder({
    model: options.model,
    dims: options.dims,
    batchSize: options.batchSize ?? 50,
    documentInput: prefixedDocumentInput,
    queryInput: prefixedQueryInput,
    embedBatch: (inputs, purpose) => client.embed(inputs, options.dims, purpose),
  });
}
