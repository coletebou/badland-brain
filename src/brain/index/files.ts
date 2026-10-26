import { existsSync, renameSync, rmSync } from 'node:fs';

/** A SQLite database in WAL mode is up to three files. */
const SIDECARS = ['', '-wal', '-shm'];

export const removeIndexFiles = (base: string): void => {
  for (const suffix of SIDECARS) {
    rmSync(`${base}${suffix}`, { force: true });
  }
};

/** Move a database and whichever of its sidecars exist. */
export const moveIndexFiles = (from: string, to: string): void => {
  for (const suffix of SIDECARS) {
    if (existsSync(`${from}${suffix}`)) {
      renameSync(`${from}${suffix}`, `${to}${suffix}`);
    }
  }
};

export const rebuildPathOf = (dbPath: string): string => `${dbPath}.rebuild`;
export const previousPathOf = (dbPath: string): string => `${dbPath}.previous`;

export type SwapRecovery = 'none' | 'restored' | 'stale-previous';

/**
 * A crash between moving the live index aside and opening its replacement leaves only `<db>.previous`; put it
 * back so a restart does not begin from an empty index that is not marked stale ('restored'). When both files
 * exist the swap had completed but its retire cleanup never ran, so `<db>.previous` may hold late recall rows;
 * leave it for the caller to merge and remove ('stale-previous').
 */
export function recoverInterruptedSwap(dbPath: string): SwapRecovery {
  const previous = previousPathOf(dbPath);
  if (!existsSync(previous)) {
    return 'none';
  }
  if (existsSync(dbPath)) {
    return 'stale-previous';
  }
  moveIndexFiles(previous, dbPath);
  return 'restored';
}
