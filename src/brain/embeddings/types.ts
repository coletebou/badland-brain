export interface Embedder {
  /** Recorded in the index identity: a different model or size marks the index stale until a reindex. */
  readonly model: string;
  readonly dims: number;
  /** How one chunk is presented to the model. Part of the embedding cache key. */
  documentInput(p: { title: string; tags: string[]; text: string }): string;
  /** How a search query is presented to the model. */
  queryInput(query: string): string;
  /** Embed formatted document inputs, one unit-length vector per input, in order. */
  embedDocuments(inputs: string[]): Promise<Float32Array[]>;
  /** Embed one formatted query. */
  embedQuery(query: string): Promise<Float32Array>;
}

export function normalize(vector: Float32Array): Float32Array {
  let sum = 0;
  for (const value of vector) {
    sum += value * value;
  }
  const norm = Math.sqrt(sum) || 1;
  return Float32Array.from(vector, (value) => value / norm);
}

/** Gemini Embedding 2 takes task prefixes in the text instead of a task_type parameter. */
export const prefixedDocumentInput = (p: { title: string; tags: string[]; text: string }): string =>
  `title: ${p.title} | text: ${p.tags.join(' ')}\n\n${p.text}`;
export const prefixedQueryInput = (query: string): string => `task: search result | query: ${query}`;

/** Batch, check, and normalize around a client that embeds one batch of inputs. */
export function batchingEmbedder(options: {
  model: string;
  dims: number;
  batchSize: number;
  documentInput: Embedder['documentInput'];
  queryInput: Embedder['queryInput'];
  embedBatch: (inputs: string[], purpose: EmbedPurpose) => Promise<Float32Array[]>;
}): Embedder {
  const embed = async (inputs: string[], purpose: EmbedPurpose): Promise<Float32Array[]> => {
    const out: Float32Array[] = [];
    for (let i = 0; i < inputs.length; i += options.batchSize) {
      const batch = inputs.slice(i, i + options.batchSize);
      const vectors = await options.embedBatch(batch, purpose);
      if (vectors.length !== batch.length) {
        throw new Error(`the embedding provider returned ${vectors.length} embeddings for ${batch.length} inputs`);
      }
      for (const vector of vectors) {
        if (vector.length !== options.dims) {
          throw new Error(`embedding has ${vector.length} dims, expected ${options.dims}; set BRAIN_EMBED_DIMS to the model's size`);
        }
        out.push(normalize(vector));
      }
    }
    return out;
  };
  return {
    model: options.model,
    dims: options.dims,
    documentInput: options.documentInput,
    queryInput: options.queryInput,
    embedDocuments: (inputs) => embed(inputs, 'documents'),
    async embedQuery(query) {
      const [vector] = await embed([query], 'query');
      return vector;
    },
  };
}

/**
 * Document batches (writes, imports, reindex) wait longer and retry; a query is one short attempt, because the search
 * that waits on it falls back to keyword results when the vector leg fails, and a hung provider must not stall it.
 */
export type EmbedPurpose = 'documents' | 'query';
export const EMBED_ATTEMPTS: Record<EmbedPurpose, { timeoutMs: number; retryDelaysMs: readonly number[] }> = {
  documents: { timeoutMs: 30_000, retryDelaysMs: [500, 2000] },
  query: { timeoutMs: 10_000, retryDelaysMs: [] },
};

const RETRY_STATUS = new Set([408, 429, 500, 502, 503, 504]);

/**
 * POST JSON with a per-attempt timeout, retrying throttling and server errors twice with backoff. The error names
 * the provider and status plus the provider's own short message, never a header (where the credential travels).
 */
export async function postJson(options: {
  provider: string;
  url: string;
  headers: Record<string, string>;
  body: unknown;
  timeoutMs: number;
  fetchImpl?: typeof fetch;
  retryDelaysMs?: readonly number[];
}): Promise<unknown> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const delays = options.retryDelaysMs ?? [500, 2000];
  for (let attempt = 0; ; attempt++) {
    let response: Response;
    try {
      response = await fetchImpl(options.url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...options.headers },
        body: JSON.stringify(options.body),
        signal: AbortSignal.timeout(options.timeoutMs),
      });
    } catch (error) {
      if (attempt < delays.length) {
        await new Promise((resolve) => setTimeout(resolve, delays[attempt]));
        continue;
      }
      throw new Error(`${options.provider} embedding request failed: ${String((error as Error).message ?? error).slice(0, 200)}`);
    }
    if (response.ok) {
      return response.json();
    }
    if (RETRY_STATUS.has(response.status) && attempt < delays.length) {
      await response.body?.cancel();
      await new Promise((resolve) => setTimeout(resolve, delays[attempt]));
      continue;
    }
    const detail = await response.json().then(
      (json: unknown) => {
        const error = (json as { error?: { message?: unknown } | string } | null)?.error;
        return typeof error === 'string' ? error : String(error?.message ?? '');
      },
      () => '',
    );
    throw new Error(`${options.provider} embedding request failed with ${response.status}${detail ? `: ${detail.slice(0, 200)}` : ''}`);
  }
}
