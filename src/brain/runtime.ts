import { type Logger, silentLogger } from '../log.js';
import type { BrainConfig } from './config.js';
import { type Embedder, createEmbedder } from './embeddings/index.js';
import { previousPathOf, recoverInterruptedSwap, removeIndexFiles } from './index/files.js';
import type { IndexIdentity } from './index/schema.js';
import { type BrainIndex, openBrainIndex } from './index/sqlite.js';
import { BrainStore } from './store.js';

/** An in-process reindex replaces `index` and `stale` and re-points `store` at the new index (see reindex.ts). */
export interface BrainRuntime {
  config: BrainConfig;
  index: BrainIndex;
  embedder: Embedder;
  store: BrainStore;
  stale: boolean;
  /** Operational warnings from search (a failed vector leg) go to the server's logger. */
  warn?: (message: string, meta?: Record<string, unknown>) => void;
}

export const identityOf = (config: BrainConfig, embedder: Embedder): IndexIdentity => ({
  embedModel: embedder.model,
  embedDims: embedder.dims,
  chunkTokens: config.chunkTokens,
  chunkOverlap: config.chunkOverlap,
  ftsTokenizer: config.ftsTokenizer,
});

/**
 * Open the index (repairing an interrupted reindex swap first) and build the store around it. Throws with a message
 * that names a setting or a path, never a value.
 */
export function createBrainRuntime(config: BrainConfig, opts: { env?: NodeJS.ProcessEnv; embedder?: Embedder; index?: BrainIndex; logger?: Logger } = {}): BrainRuntime {
  const logger = opts.logger ?? silentLogger;
  const embedder = opts.embedder ?? createEmbedder(config, opts.env);
  const recovery = opts.index ? 'none' : recoverInterruptedSwap(config.dbPath);
  if (recovery === 'restored') {
    logger.warn('brain index restored after an interrupted reindex swap', { dbPath: config.dbPath });
  }
  const index = opts.index ?? openBrainIndex({ path: config.dbPath, identity: identityOf(config, embedder) });
  if (recovery === 'stale-previous') {
    // A crash between a completed swap and its retire cleanup left the old file, which may hold late recall rows; merge them, then drop it.
    const previous = previousPathOf(config.dbPath);
    index.adoptRecallFrom(previous, 0);
    removeIndexFiles(previous);
    logger.warn('brain index merged late recall from an interrupted swap cleanup', { dbPath: config.dbPath });
  }
  if (index.stale) {
    logger.warn('brain index identity does not match the configured embedding; searches are keyword-only until a reindex', { dbPath: config.dbPath });
  }
  return { config, index, embedder, store: new BrainStore({ index, embedder, config }), stale: index.stale, warn: (message, meta) => logger.warn(message, meta) };
}
