import { renameSync, rmSync } from 'node:fs';

import { type Logger, reasonOf, silentLogger } from '../log.js';
import { moveIndexFiles, previousPathOf, rebuildPathOf, removeIndexFiles } from './index/files.js';
import type { IndexIdentity } from './index/schema.js';
import { type BrainIndex, openBrainIndex } from './index/sqlite.js';
import { BrainEntry } from './model.js';
import { type BrainRuntime, identityOf } from './runtime.js';
import { BrainStore } from './store.js';

export interface ReindexStatus {
  state: 'idle' | 'running' | 'done' | 'failed';
  startedAt: string | null;
  finishedAt: string | null;
  entries: number;
  chunks: number;
  caughtUp: number;
  error: string | null;
}

export interface ReindexOptions {
  /** Tests inject an opener that fails on demand; production uses openBrainIndex. */
  openIndex?: typeof openBrainIndex;
  logger?: Logger;
}

const IDLE: ReindexStatus = { state: 'idle', startedAt: null, finishedAt: null, entries: 0, chunks: 0, caughtUp: 0, error: null };
let status: ReindexStatus = IDLE;
let running: Promise<void> | null = null;
// Set while a retired handle from the last swap is still draining; a reindex requested meanwhile is accepted but
// waits on it, so it cannot reuse the fixed <db>.previous path out from under the first generation's recall
// carry-over and file cleanup.
let pendingRetire: Promise<void> | null = null;

export const getReindexStatus = (): ReindexStatus => ({ ...status });

/**
 * Install the rebuilt file as the live index. The live file is moved aside, not deleted, until the new handle opens;
 * a failure at any step moves it back and the runtime keeps the handle it had, so it never holds a closed one and a
 * restart never finds an empty index. The retired handle is not closed while a request that captured it is still in
 * flight.
 */
function installRebuild(runtime: BrainRuntime, identity: IndexIdentity, openIndex: typeof openBrainIndex, recallCopiedAtMs: number): void {
  const { config } = runtime;
  const previous = previousPathOf(config.dbPath);
  // The store object is kept: handlers snapshot `runtime.store` per request, so re-pointing it (rather than
  // replacing it) makes a write that commits after the swap land in the new index instead of a closed handle.
  const adopt = (index: BrainIndex): void => {
    runtime.index = index;
    runtime.store.setIndex(index);
    runtime.stale = index.stale;
  };
  const live = runtime.index;
  removeIndexFiles(previous);
  let rebuildInstalled = false;
  try {
    moveIndexFiles(config.dbPath, previous);
    renameSync(rebuildPathOf(config.dbPath), config.dbPath);
    rebuildInstalled = true;
    adopt(openIndex({ path: config.dbPath, identity }));
  } catch (error) {
    // Undo whatever moved: drop the rebuild if it landed, then put every previous file back. The live handle was
    // never closed and keeps serving from the file that is back in place.
    if (rebuildInstalled) {
      removeIndexFiles(config.dbPath);
    }
    moveIndexFiles(previous, config.dbPath);
    adopt(live);
    throw error;
  }
  // Requests that captured the old handle before the swap finish against it; it closes once the last of them
  // releases it. Recall rows they appended after the rebuild copied the history are carried over then, and the
  // previous files go. A restart meanwhile treats a leftover copy as completed.
  let settleRetire: () => void = () => undefined;
  pendingRetire = new Promise<void>((resolve) => { settleRetire = resolve; });
  live.retire(() => {
    try {
      runtime.index.adoptRecallFrom(previous, recallCopiedAtMs);
      removeIndexFiles(previous);
    } finally {
      pendingRetire = null;
      settleRetire();
    }
  });
}

/**
 * Rebuild the index inside the server process, then swap the live handle. Building happens in a sibling file while
 * the live index keeps serving; entries written meanwhile are re-indexed afterwards.
 */
export function startReindex(runtime: BrainRuntime, opts: ReindexOptions = {}): ReindexStatus {
  if (running) {
    // A run is in progress (it may still be waiting for the previous run's retired handle to drain): report it.
    return getReindexStatus();
  }
  const openIndex = opts.openIndex ?? openBrainIndex;
  const logger = opts.logger ?? silentLogger;
  // The previous run's retired handle may still be draining into the live index. This request is accepted now, so
  // the caller is never answered with the previous run's `done` for work that did not happen, but the job waits for
  // that drain before touching any file: the previous generation's recall carry-over and cleanup use the fixed
  // <db>.previous path, and the recall copy below must see the rows the drain carries over.
  const drain = pendingRetire;
  const startedAt = new Date();
  status = { ...IDLE, state: 'running', startedAt: startedAt.toISOString() };
  const job = (async () => {
    if (drain) {
      await drain;
    }
    const { config, embedder } = runtime;
    const identity = identityOf(config, embedder);
    const rebuildPath = rebuildPathOf(config.dbPath);
    let rebuild: BrainIndex | null = null;
    try {
      removeIndexFiles(rebuildPath);
      rebuild = openIndex({ path: rebuildPath, identity });
      rebuild.adoptCacheFrom(config.dbPath);
      const counts = await new BrainStore({ index: rebuild, embedder, config }).reindexAll();
      // After the chunks exist, so each recall row can be re-pointed at its rebuilt chunk. Rows recorded from this
      // instant on land in the old file and are carried over when its handle retires.
      const recallCopiedAtMs = Date.now();
      rebuild.adoptRecallFrom(config.dbPath);
      rebuild.close();
      rmSync(`${rebuildPath}-wal`, { force: true });
      rmSync(`${rebuildPath}-shm`, { force: true });
      installRebuild(runtime, identity, openIndex, recallCopiedAtMs);

      // Catch up anything written while the rebuild ran. The index ignores snapshots older than what a concurrent
      // write already stored, so a slow embedding here cannot overwrite a newer version.
      let caughtUp = 0;
      for await (const doc of BrainEntry.find({ updatedAt: { $gte: startedAt } }).cursor()) {
        await runtime.store.indexEntry(doc);
        caughtUp += 1;
      }
      status = { ...status, state: 'done', finishedAt: new Date().toISOString(), entries: counts.entries, chunks: counts.chunks, caughtUp };
      logger.info('brain reindex complete', { entries: counts.entries, chunks: counts.chunks, caughtUp });
    } catch (error) {
      try {
        rebuild?.close();
      } catch {
        // already closed
      }
      removeIndexFiles(rebuildPath);
      const reason = reasonOf(error);
      status = { ...status, state: 'failed', finishedAt: new Date().toISOString(), error: reason };
      logger.error('brain reindex failed', { reason });
    }
  })();
  // Release the slot only once `running` holds this job: a failure before the first await settles the promise
  // synchronously, and clearing from inside the job would then be overwritten here.
  running = job.finally(() => {
    running = null;
  });
  return getReindexStatus();
}

/** Await the in-flight job, if any. Tests and the CLI poll status instead. */
export async function waitForReindex(): Promise<ReindexStatus> {
  await running;
  return getReindexStatus();
}

export function resetReindexForTests(): void {
  pendingRetire = null;
  status = IDLE;
  running = null;
}
