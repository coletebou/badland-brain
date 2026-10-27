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
/**
 * Writes stamp `updatedAt` before MongoDB applies them, so one already in flight when a rebuild starts can carry an
 * earlier time and still be missing from the rebuild's cursor: the catch-up reaches back this far before the start.
 */
const CATCH_UP_MARGIN_MS = 60_000;
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
 * flight. Moving its files while it is open is safe in WAL mode: it keeps writing through the WAL and shared memory
 * it already has open, and when it finally closes, SQLite sees that its database file has moved
 * (SQLITE_FCNTL_HAS_MOVED) and skips the close-time checkpoint and the removal of the -wal and -shm files by name,
 * names that by then belong to the new index. The reindex tests pin this down.
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
    const catchUpFromMs = startedAt.getTime() - CATCH_UP_MARGIN_MS;
    const live = runtime.index;
    let rebuild: BrainIndex | null = null;
    try {
      removeIndexFiles(rebuildPath);
      rebuild = openIndex({ path: rebuildPath, identity });
      live.mirrorRemovalsTo(rebuild);
      rebuild.adoptCacheFrom(config.dbPath);
      const counts = await new BrainStore({ index: rebuild, embedder, config }).reindexAll();
      // After the chunks exist, so each recall row can be re-pointed at its rebuilt chunk. Rows recorded from this
      // instant on land in the old file and are carried over when its handle retires.
      const recallCopiedAtMs = Date.now();
      rebuild.adoptRecallFrom(config.dbPath);
      // Until the catch-up after the swap has run, the rebuilt file lacks what was written while it was being built.
      // The mark travels with the file, so a process that stops before the catch-up finishes replays it at its next
      // start, before serving (see resumeCatchUp).
      rebuild.setPendingCatchUp(catchUpFromMs);
      live.mirrorRemovalsTo(null);
      rebuild.close();
      rmSync(`${rebuildPath}-wal`, { force: true });
      rmSync(`${rebuildPath}-shm`, { force: true });
      installRebuild(runtime, identity, openIndex, recallCopiedAtMs);

      const caughtUp = await catchUpAll(runtime, catchUpFromMs);
      runtime.index.setPendingCatchUp(null);
      status = { ...status, state: 'done', finishedAt: new Date().toISOString(), entries: counts.entries, chunks: counts.chunks, caughtUp };
      logger.info('brain reindex complete', { entries: counts.entries, chunks: counts.chunks, caughtUp });
    } catch (error) {
      live.mirrorRemovalsTo(null);
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

/**
 * Index into the live index what changed since `fromMs`: the entries forgotten since then (`removals`, which need no
 * embedding, so a provider outage cannot keep one searchable) or every other changed entry (`writes`). An entry the
 * index already holds at its current version is left alone, so its chunks, and the recall rows pointing at them,
 * keep their ids. The index ignores snapshots older than what a concurrent write already stored, so a slow embedding
 * here cannot overwrite a newer version.
 */
async function catchUp(runtime: BrainRuntime, fromMs: number, phase: 'removals' | 'writes'): Promise<number> {
  let caughtUp = 0;
  for await (const doc of BrainEntry.find({ updatedAt: { $gte: new Date(fromMs) }, forgotten: { $exists: phase === 'removals' } }).cursor()) {
    const entryId = doc._id.toString();
    if (phase === 'removals' ? runtime.index.hasEntry(entryId) : !runtime.store.isIndexed(entryId, doc.updatedAt)) {
      await runtime.store.indexEntry(doc);
      caughtUp += 1;
    }
  }
  return caughtUp;
}

const catchUpAll = async (runtime: BrainRuntime, fromMs: number): Promise<number> =>
  (await catchUp(runtime, fromMs, 'removals')) + (await catchUp(runtime, fromMs, 'writes'));

/**
 * At startup, before serving: finish the catch-up of a reindex whose process stopped after installing the rebuilt
 * file and before catching it up. The removals must land, or no forgotten entry could be ruled out; the remaining
 * writes may wait for a provider that is down, so a failure there is logged and the mark kept for the next start.
 */
export async function resumeCatchUp(runtime: BrainRuntime, logger: Logger = silentLogger): Promise<void> {
  const fromMs = runtime.index.pendingCatchUp();
  if (fromMs === null) {
    return;
  }
  logger.warn('brain index finishing the catch-up of an interrupted reindex', { since: new Date(fromMs).toISOString() });
  const removed = await catchUp(runtime, fromMs, 'removals');
  try {
    const written = await catchUp(runtime, fromMs, 'writes');
    runtime.index.setPendingCatchUp(null);
    logger.info('brain index caught up', { caughtUp: removed + written });
  } catch (error) {
    logger.error('brain index catch-up incomplete; entries written during the interrupted reindex may read stale until the next start or reindex', { reason: reasonOf(error) });
  }
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
