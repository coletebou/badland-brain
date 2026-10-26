import type { DatabaseSync } from 'node:sqlite';

export const SCHEMA_VERSION = 1;

/** Everything that, when changed, invalidates every stored vector or FTS row. */
export interface IndexIdentity {
  embedModel: string;
  embedDims: number;
  chunkTokens: number;
  chunkOverlap: number;
  ftsTokenizer: string;
}

const IDENTITY_KEYS = ['embedModel', 'embedDims', 'chunkTokens', 'chunkOverlap', 'ftsTokenizer'] as const;

const sqlString = (value: string): string => value.replaceAll("'", "''");

/**
 * Create the derived index tables. `chunks_fts` is contentless: rows are inserted with an explicit rowid equal to
 * the chunk id and removed with the FTS5 'delete' command carrying the same column values, which `BrainIndex` reads
 * back from `chunks` and `entries` before deleting. `chunks_vec` is partitioned by scope (vec0 partition filters
 * are equality only, so a search runs one KNN per scope) and carries the namespace as a metadata column, which a
 * KNN query can filter with `=` or `IN`, so a namespace-confined search ranks only what it may see.
 */
export function ensureSchema(db: DatabaseSync, identity: IndexIdentity): { created: boolean } {
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA synchronous = NORMAL');
  db.exec('PRAGMA foreign_keys = ON');
  db.exec('PRAGMA busy_timeout = 5000');
  const created = db.prepare("SELECT 1 AS found FROM sqlite_master WHERE type = 'table' AND name = 'meta'").get() === undefined;
  db.exec(`
    CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL) STRICT;
    CREATE TABLE IF NOT EXISTS entries (
      entry_id TEXT PRIMARY KEY,
      slug TEXT NOT NULL,
      title TEXT NOT NULL,
      tags TEXT NOT NULL DEFAULT '',
      kind TEXT NOT NULL,
      scope TEXT NOT NULL,
      tier TEXT NOT NULL,
      namespace TEXT NOT NULL,
      origin_class TEXT NOT NULL,
      author_agent TEXT NOT NULL DEFAULT '',
      importance INTEGER NOT NULL,
      valid_from_ms INTEGER NOT NULL,
      invalid_at_ms INTEGER,
      updated_at_ms INTEGER NOT NULL
    ) STRICT;
    CREATE INDEX IF NOT EXISTS entries_scope ON entries(scope, tier);
    CREATE INDEX IF NOT EXISTS entries_namespace ON entries(namespace);
    CREATE TABLE IF NOT EXISTS chunks (
      id INTEGER PRIMARY KEY,
      entry_id TEXT NOT NULL REFERENCES entries(entry_id) ON DELETE CASCADE,
      ord INTEGER NOT NULL,
      start_line INTEGER NOT NULL,
      end_line INTEGER NOT NULL,
      text TEXT NOT NULL,
      UNIQUE(entry_id, ord)
    ) STRICT;
    CREATE VIRTUAL TABLE IF NOT EXISTS chunks_fts USING fts5(
      text, title, tags, content='', tokenize='${sqlString(identity.ftsTokenizer)}', prefix='2 3'
    );
    CREATE VIRTUAL TABLE IF NOT EXISTS chunks_vec USING vec0(
      chunk_id INTEGER PRIMARY KEY,
      scope TEXT PARTITION KEY,
      namespace TEXT,
      embedding FLOAT[${identity.embedDims}] distance_metric=cosine
    );
    CREATE TABLE IF NOT EXISTS recall (
      id INTEGER PRIMARY KEY,
      query_hash TEXT NOT NULL,
      agent TEXT NOT NULL,
      chunk_id INTEGER NOT NULL,
      entry_id TEXT NOT NULL,
      rank INTEGER NOT NULL,
      at_ms INTEGER NOT NULL
    ) STRICT;
    CREATE INDEX IF NOT EXISTS recall_entry ON recall(entry_id, at_ms);
    CREATE TABLE IF NOT EXISTS embed_cache (key TEXT PRIMARY KEY, vec BLOB NOT NULL, at_ms INTEGER NOT NULL) STRICT;
  `);
  if (created) {
    const put = db.prepare('INSERT OR REPLACE INTO meta(key, value) VALUES (?, ?)');
    put.run('schema_version', String(SCHEMA_VERSION));
    for (const key of IDENTITY_KEYS) {
      put.run(key, String(identity[key]));
    }
  }
  return { created };
}

export function readIdentity(db: DatabaseSync): IndexIdentity | null {
  const rows = db.prepare('SELECT key, value FROM meta').all() as Array<{ key: string; value: string }>;
  const meta = new Map(rows.map((row) => [row.key, row.value]));
  const embedModel = meta.get('embedModel');
  if (!embedModel) {
    return null;
  }
  return {
    embedModel,
    embedDims: Number(meta.get('embedDims')),
    chunkTokens: Number(meta.get('chunkTokens')),
    chunkOverlap: Number(meta.get('chunkOverlap')),
    ftsTokenizer: meta.get('ftsTokenizer') ?? '',
  };
}

export const identityMatches = (a: IndexIdentity, b: IndexIdentity): boolean =>
  IDENTITY_KEYS.every((key) => String(a[key]) === String(b[key]));

/** The schema version stored in a database, or 0 for a pre-versioned file; a mismatch marks the index stale so a reindex rebuilds it. */
export function readSchemaVersion(db: DatabaseSync): number {
  const row = db.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get() as { value: string } | undefined;
  return row ? Number(row.value) : 0;
}
