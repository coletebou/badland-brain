import { createHash } from 'node:crypto';

import { type Chunk, chunkMarkdown } from './chunk.js';
import { BRAIN_SCOPE_OF_KIND, type BrainConfig } from './config.js';
import type { Embedder } from './embeddings/index.js';
import type { BrainIndex, IndexChunkInput, IndexEntryRow } from './index/sqlite.js';
import { BrainEntry, type IBrainEntryDocument } from './model.js';

export interface IndexDeps {
  index: BrainIndex;
  embedder: Embedder;
  config: BrainConfig;
}

export function rowFor(doc: IBrainEntryDocument): IndexEntryRow {
  return {
    entryId: doc._id.toString(),
    slug: doc.slug,
    title: doc.title,
    tags: doc.tags.join(' '),
    kind: doc.kind,
    scope: BRAIN_SCOPE_OF_KIND[doc.kind],
    tier: doc.tier,
    namespace: doc.namespace,
    originClass: doc.originClass,
    authorAgent: doc.authorAgent,
    importance: doc.importance,
    validFromMs: doc.validFrom.getTime(),
    invalidAtMs: doc.invalidAt ? doc.invalidAt.getTime() : null,
    updatedAtMs: doc.updatedAt.getTime(),
  };
}

const cacheKey = (embedder: Embedder, input: string): string =>
  createHash('sha256').update(`${embedder.model}|${embedder.dims}|${input}`).digest('hex');

const toChunkInput = (chunk: Chunk, embedding: Float32Array | null): IndexChunkInput =>
  ({ ord: chunk.ord, startLine: chunk.startLine, endLine: chunk.endLine, text: chunk.text, embedding });

/**
 * Chunk the body and embed each chunk, reusing cached vectors for unchanged inputs. A stale index still carries
 * another model's vec0 table, so writes to it keep only the keyword rows current and leave vectors to the reindex.
 */
export async function embedChunks(deps: IndexDeps, doc: IBrainEntryDocument): Promise<IndexChunkInput[]> {
  const chunks = chunkMarkdown(doc.body, deps.config);
  if (deps.index.stale) {
    return chunks.map((chunk) => toChunkInput(chunk, null));
  }
  const inputs = chunks.map((chunk) => deps.embedder.documentInput({ title: doc.title, tags: doc.tags, text: chunk.text }));
  const keys = inputs.map((input) => cacheKey(deps.embedder, input));
  const vectors: Array<Float32Array | null> = keys.map((key) => deps.index.cacheGet(key));
  const missing = vectors.flatMap((vector, i) => (vector === null ? [i] : []));
  if (missing.length > 0) {
    const fresh = await deps.embedder.embedDocuments(missing.map((i) => inputs[i]));
    missing.forEach((i, j) => {
      vectors[i] = fresh[j];
      deps.index.cachePut(keys[i], fresh[j]);
    });
  }
  return chunks.map((chunk, i) => toChunkInput(chunk, vectors[i]));
}

/**
 * Bring the index in step with one document: forgotten entries leave, everything else is upserted. Embedding takes
 * time, and a forget or a newer save can land meanwhile; a removal leaves no row for the stale-write guard to compare
 * with, so the document is re-read before anything is written, and the row is built from that re-read rather than
 * the caller's snapshot: a save that touched only some paths (a tag repair, a demotion) after another writer retired
 * the entry must never publish the snapshot's `live`/`invalidAt` under a fresh updatedAt.
 */
export async function indexDocument(deps: IndexDeps, doc: IBrainEntryDocument): Promise<number> {
  const release = deps.index.retain();
  try {
    const entryId = doc._id.toString();
    if (doc.forgotten) {
      deps.index.removeEntry(entryId);
      return 0;
    }
    const chunks = await embedChunks(deps, doc);
    // The body never changes on an existing entry, so the chunks above stay valid for the stored document.
    const current = await BrainEntry.findById(doc._id, '-body');
    if (!current || current.forgotten) {
      deps.index.removeEntry(entryId);
      return 0;
    }
    if (current.updatedAt.getTime() > doc.updatedAt.getTime()) {
      return 0; // a newer version exists; its own writer, or a repair, indexes it
    }
    deps.index.upsertEntry(rowFor(current), chunks);
    return chunks.length;
  } finally {
    release();
  }
}
