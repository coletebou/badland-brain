import { createHash } from 'node:crypto';

import { type Embedder, normalize, prefixedDocumentInput, prefixedQueryInput } from './types.js';

/** Prompt-format scaffolding shared by every input; ignored so it cannot manufacture similarity. */
const SCAFFOLD = new Set(['task', 'search', 'result', 'query', 'title', 'text']);

/**
 * Deterministic hashed bag-of-words embedder for tests and offline trials: texts that share tokens land close
 * together, and the same text always yields the same vector. It has no notion of meaning.
 */
export function createFakeEmbedder(dims = 32): Embedder {
  const one = (text: string): Float32Array => {
    const vector = new Float32Array(dims);
    for (const token of text.toLowerCase().match(/[a-z0-9_.-]+/gu) ?? []) {
      if (SCAFFOLD.has(token)) {
        continue;
      }
      const hash = createHash('sha1').update(token).digest();
      vector[hash[0] % dims] += 1;
      vector[hash[1] % dims] += 0.5;
    }
    return normalize(vector);
  };
  return {
    model: 'fake',
    dims,
    documentInput: prefixedDocumentInput,
    queryInput: prefixedQueryInput,
    embedDocuments: async (inputs) => inputs.map(one),
    embedQuery: async (query) => one(query),
  };
}
