import { EMBED_ATTEMPTS, type Embedder, batchingEmbedder, postJson } from './types.js';

/** Models that accept a `dimensions` request field; every other model must be configured at its native size. */
const takesDimensions = (model: string): boolean => model.startsWith('text-embedding-3');

/**
 * Any OpenAI-compatible `/embeddings` endpoint: OpenAI itself, or a local or hosted server that speaks the same API.
 * The key is optional because local servers often need none; it travels in the Authorization header.
 */
export function createOpenAiEmbedder(options: {
  apiKey?: string;
  model: string;
  dims: number;
  baseUrl: string;
  batchSize?: number;
  fetchImpl?: typeof fetch;
}): Embedder {
  const url = `${options.baseUrl.replace(/\/+$/u, '')}/embeddings`;
  return batchingEmbedder({
    model: options.model,
    dims: options.dims,
    batchSize: options.batchSize ?? 50,
    documentInput: (p) => `${p.title}${p.tags.length > 0 ? `\n${p.tags.join(' ')}` : ''}\n\n${p.text}`,
    queryInput: (query) => query,
    async embedBatch(inputs, purpose) {
      const json = await postJson({
        provider: 'OpenAI-compatible',
        url,
        headers: options.apiKey ? { authorization: `Bearer ${options.apiKey}` } : {},
        body: { model: options.model, input: inputs, encoding_format: 'float', ...(takesDimensions(options.model) ? { dimensions: options.dims } : {}) },
        ...EMBED_ATTEMPTS[purpose],
        fetchImpl: options.fetchImpl,
      }) as { data?: Array<{ index?: number; embedding?: number[] }> };
      const rows = [...(json.data ?? [])].sort((a, b) => (a.index ?? 0) - (b.index ?? 0));
      return rows.map((row) => Float32Array.from(row.embedding ?? []));
    },
  });
}
