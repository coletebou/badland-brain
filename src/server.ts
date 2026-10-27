import { type Server, createServer } from 'node:http';
import type { AddressInfo } from 'node:net';

import mongoose from 'mongoose';

import { KeyStore } from './auth/keys.js';
import type { Embedder } from './brain/embeddings/index.js';
import { BrainEntry } from './brain/model.js';
import { resumeCatchUp } from './brain/reindex.js';
import { type BrainRuntime, createBrainRuntime } from './brain/runtime.js';
import type { ServerConfig } from './config.js';
import { createApp } from './http/app.js';
import { type Logger, createLogger } from './log.js';
import { VERSION } from './version.js';

export interface RunningServer {
  /** The base URL clients use, e.g. http://127.0.0.1:8270. */
  url: string;
  runtime: BrainRuntime;
  close(): Promise<void>;
}

/**
 * Connect to MongoDB, wait for the collection's indexes (the unique ones are what make deduplication and import
 * identities race-safe), open the SQLite index, finish the catch-up of a reindex that was interrupted after its swap,
 * and listen. `close()` stops listening, closes the index and disconnects; a second call is a no-op.
 */
export async function startServer(config: ServerConfig, opts: { embedder?: Embedder; logger?: Logger; connect?: boolean } = {}): Promise<RunningServer> {
  const logger = opts.logger ?? createLogger(config.logLevel);
  const keys = new KeyStore({ file: config.keysFile, inline: config.inlineKeys, logger });
  if (opts.connect !== false) {
    await mongoose.connect(config.mongoUri, { serverSelectionTimeoutMS: 10_000 });
  }
  await BrainEntry.init();
  const runtime = createBrainRuntime(config.brain, { embedder: opts.embedder, logger });
  await resumeCatchUp(runtime, logger);
  const app = createApp({
    runtime, keys, logger,
    rateLimitPerMinute: config.rateLimitPerMinute,
    writeRateLimitPerMinute: config.writeRateLimitPerMinute,
    agentQuota: config.agentQuota,
  });
  const server: Server = createServer(app);
  server.requestTimeout = 120_000;
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(config.port, config.host, () => {
      server.off('error', reject);
      resolve();
    });
  });
  const address = server.address() as AddressInfo;
  const host = address.family === 'IPv6' ? `[${address.address}]` : address.address;
  const url = `http://${host}:${address.port}`;
  if (keys.list().length === 0) {
    logger.warn('no keys configured; every request will be refused until you mint one (badland-brain keys mint --help)', { keysFile: config.keysFile });
  }
  logger.info('badland-brain listening', { url, version: VERSION, model: runtime.embedder.model, dims: runtime.embedder.dims, stale: runtime.stale, ...runtime.index.counts() });

  let closing: Promise<void> | null = null;
  return {
    url,
    runtime,
    close: () => {
      closing ??= (async () => {
        await new Promise<void>((resolve) => {
          server.close(() => resolve());
          server.closeAllConnections();
        });
        runtime.index.close();
        if (opts.connect !== false) {
          await mongoose.disconnect();
        }
      })();
      return closing;
    },
  };
}
