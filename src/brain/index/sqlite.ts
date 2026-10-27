import { chmodSync, existsSync, mkdirSync, statSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';

import * as sqliteVec from 'sqlite-vec';

import { type IndexIdentity, SCHEMA_VERSION, ensureSchema, identityMatches, readIdentity, readSchemaVersion } from './schema.js';

export interface IndexEntryRow {
  entryId: string;
  slug: string;
  title: string;
  tags: string;
  kind: string;
  scope: string;
  tier: string;
  namespace: string;
  originClass: string;
  authorAgent: string;
  importance: number;
  validFromMs: number;
  invalidAtMs: number | null;
  updatedAtMs: number;
}

export interface IndexChunkInput {
  ord: number;
  startLine: number;
  endLine: number;
  text: string;
  embedding: Float32Array | null;
}

export interface IndexChunkRow extends IndexEntryRow {
  chunkId: number;
  ord: number;
  startLine: number;
  endLine: number;
  text: string;
}

export interface KnnHit { chunkId: number; distance: number }
export interface FtsHit { chunkId: number; rank: number }

export interface LegFilter {
  scopes: string[];
  kinds?: string[];
  tier?: string;
  /** Only these namespaces; absent means every namespace, and an empty list matches nothing. */
  namespaces?: readonly string[];
  validAtMs?: number;
  includeSuperseded?: boolean;
  /** "Now" for the default current-facts filter; the wall clock when omitted. */
  nowMs?: number;
}

export interface RecallRow { queryHash: string; agent: string; chunkId: number; entryId: string; rank: number }

type Param = string | number | bigint | null | Uint8Array;

/** Upper bound, as a multiple of k, on how far one KNN fetch widens past the requested size. */
const KNN_MAX_WIDEN = 64;
/** sqlite-vec (vec0) rejects a knn query with k above this; the widen loop must never ask for more. */
const VEC0_MAX_K = 4096;

const toBlob = (vector: Float32Array): Uint8Array => new Uint8Array(vector.buffer, vector.byteOffset, vector.byteLength);
const fromBlob = (blob: Uint8Array): Float32Array =>
  new Float32Array(blob.buffer.slice(blob.byteOffset, blob.byteOffset + blob.byteLength));
const placeholders = (values: readonly unknown[]): string => values.map(() => '?').join(',');

function whereClause(filter: LegFilter, alias = 'e'): { sql: string; params: Param[] } {
  const parts = [`${alias}.scope IN (${placeholders(filter.scopes)})`];
  const params: Param[] = [...filter.scopes];
  if (filter.kinds && filter.kinds.length > 0) {
    parts.push(`${alias}.kind IN (${placeholders(filter.kinds)})`);
    params.push(...filter.kinds);
  }
  if (filter.tier) {
    parts.push(`${alias}.tier = ?`);
    params.push(filter.tier);
  }
  if (filter.namespaces) {
    parts.push(filter.namespaces.length > 0 ? `${alias}.namespace IN (${placeholders(filter.namespaces)})` : '0');
    params.push(...filter.namespaces);
  }
  // Valid at an instant: already valid and not yet invalidated, so a future invalidAt is still current.
  const at = filter.validAtMs ?? (filter.includeSuperseded ? undefined : filter.nowMs ?? Date.now());
  if (at !== undefined) {
    parts.push(`${alias}.valid_from_ms <= ? AND (${alias}.invalid_at_ms IS NULL OR ${alias}.invalid_at_ms > ?)`);
    params.push(at, at);
  }
  return { sql: parts.join(' AND '), params };
}

interface RawChunkRow {
  chunk_id: number; ord: number; start_line: number; end_line: number; text: string;
  entry_id: string; slug: string; title: string; tags: string; kind: string; scope: string; tier: string;
  namespace: string; origin_class: string; author_agent: string; importance: number; valid_from_ms: number; invalid_at_ms: number | null; updated_at_ms: number;
}

const CHUNK_SELECT = `SELECT c.id AS chunk_id, c.ord, c.start_line, c.end_line, c.text,
  e.entry_id, e.slug, e.title, e.tags, e.kind, e.scope, e.tier, e.namespace, e.origin_class, e.author_agent,
  e.importance, e.valid_from_ms, e.invalid_at_ms, e.updated_at_ms
  FROM chunks c JOIN entries e ON e.entry_id = c.entry_id`;

const toChunkRow = (r: RawChunkRow): IndexChunkRow => ({
  chunkId: r.chunk_id, ord: r.ord, startLine: r.start_line, endLine: r.end_line, text: r.text,
  entryId: r.entry_id, slug: r.slug, title: r.title, tags: r.tags, kind: r.kind, scope: r.scope,
  tier: r.tier, namespace: r.namespace, originClass: r.origin_class, authorAgent: r.author_agent, importance: r.importance,
  validFromMs: r.valid_from_ms, invalidAtMs: r.invalid_at_ms, updatedAtMs: r.updated_at_ms,
});

/**
 * The derived SQLite index: one row per entry, one row per chunk, a contentless FTS5 table and a vec0 table over the
 * chunks. Every public method is synchronous; writes run inside a transaction.
 */
export class BrainIndex {
  private inFlight = 0;
  private onIdle: (() => void) | null = null;
  private removalMirror: BrainIndex | null = null;

  constructor(private readonly db: DatabaseSync, readonly stale: boolean) {}

  /**
   * While a rebuild runs beside this index, every entry removed here is removed from the rebuild too, so an entry
   * forgotten mid-rebuild is not served again from the moment the rebuild is installed. Best effort: the reindex
   * catch-up removes it in any case.
   */
  mirrorRemovalsTo(index: BrainIndex | null): void {
    this.removalMirror = index;
  }

  private transaction(work: () => void): void {
    this.db.exec('BEGIN');
    try {
      work();
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  private deleteChunksOf(entryId: string): void {
    const rows = this.db.prepare(
      'SELECT c.id, c.text, e.title, e.tags FROM chunks c JOIN entries e ON e.entry_id = c.entry_id WHERE c.entry_id = ?',
    ).all(entryId) as Array<{ id: number; text: string; title: string; tags: string }>;
    const deleteFts = this.db.prepare("INSERT INTO chunks_fts(chunks_fts, rowid, text, title, tags) VALUES ('delete', ?, ?, ?, ?)");
    const deleteVec = this.db.prepare('DELETE FROM chunks_vec WHERE chunk_id = ?');
    for (const row of rows) {
      deleteFts.run(BigInt(row.id), row.text, row.title, row.tags);
      deleteVec.run(BigInt(row.id));
    }
    this.db.prepare('DELETE FROM chunks WHERE entry_id = ?').run(entryId);
  }

  /** Upsert one entry and its chunks. A snapshot older than the indexed row is ignored, so a slow writer cannot undo a newer one. */
  upsertEntry(row: IndexEntryRow, chunks: IndexChunkInput[]): void {
    this.transaction(() => {
      if ((this.updatedAtOf(row.entryId) ?? -1) > row.updatedAtMs) {
        return;
      }
      this.deleteChunksOf(row.entryId);
      this.db.prepare(`INSERT OR REPLACE INTO entries(entry_id, slug, title, tags, kind, scope, tier, namespace, origin_class,
        author_agent, importance, valid_from_ms, invalid_at_ms, updated_at_ms) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
        .run(row.entryId, row.slug, row.title, row.tags, row.kind, row.scope, row.tier, row.namespace,
          row.originClass, row.authorAgent, row.importance, row.validFromMs, row.invalidAtMs, row.updatedAtMs);
      const insertChunk = this.db.prepare('INSERT INTO chunks(entry_id, ord, start_line, end_line, text) VALUES (?,?,?,?,?)');
      const insertFts = this.db.prepare('INSERT INTO chunks_fts(rowid, text, title, tags) VALUES (?,?,?,?)');
      const insertVec = this.db.prepare('INSERT INTO chunks_vec(chunk_id, scope, namespace, embedding) VALUES (?,?,?,?)');
      for (const chunk of chunks) {
        const id = Number(insertChunk.run(row.entryId, chunk.ord, chunk.startLine, chunk.endLine, chunk.text).lastInsertRowid);
        insertFts.run(BigInt(id), chunk.text, row.title, row.tags);
        if (chunk.embedding) {
          insertVec.run(BigInt(id), row.scope, row.namespace, toBlob(chunk.embedding));
        }
      }
    });
  }

  /** The updated_at_ms stored for an entry, or null when it is not indexed; lets callers detect a stale row, not just a missing one. */
  updatedAtOf(entryId: string): number | null {
    const row = this.db.prepare('SELECT updated_at_ms FROM entries WHERE entry_id = ?').get(entryId) as { updated_at_ms: number } | undefined;
    return row ? row.updated_at_ms : null;
  }

  hasEntry(entryId: string): boolean {
    return this.db.prepare('SELECT 1 AS found FROM entries WHERE entry_id = ?').get(entryId) !== undefined;
  }

  removeEntry(entryId: string): void {
    this.transaction(() => {
      this.deleteChunksOf(entryId);
      this.db.prepare('DELETE FROM entries WHERE entry_id = ?').run(entryId);
    });
    try {
      this.removalMirror?.removeEntry(entryId);
    } catch {
      // The rebuild's own catch-up removes it.
    }
  }

  /**
   * The instant from which writes made while this file was being rebuilt still have to be replayed into it, or null
   * when nothing is owed. A reindex sets it in the file it installs and clears it once its catch-up has run.
   */
  pendingCatchUp(): number | null {
    const row = this.db.prepare("SELECT value FROM meta WHERE key = 'catch_up_from'").get() as { value: string } | undefined;
    return row ? Number(row.value) : null;
  }

  setPendingCatchUp(fromMs: number | null): void {
    if (fromMs === null) {
      this.db.prepare("DELETE FROM meta WHERE key = 'catch_up_from'").run();
      return;
    }
    this.db.prepare("INSERT OR REPLACE INTO meta(key, value) VALUES ('catch_up_from', ?)").run(String(fromMs));
  }

  /**
   * One KNN per partition (vec0 partition filters are equality only), with the namespace filter applied inside vec0,
   * then the row filter. vec0 truncates to `k` before that filter can run, so each fetch widens until enough rows
   * survive the filter or the partition is exhausted, capped at KNN_MAX_WIDEN times the requested size.
   */
  knn(query: Float32Array, filter: LegFilter, k: number): KnnHit[] {
    if (filter.namespaces?.length === 0) {
      return [];
    }
    const hits: KnnHit[] = [];
    const namespaceSql = filter.namespaces ? ` AND namespace IN (${placeholders(filter.namespaces)})` : '';
    const statement = this.db.prepare(`SELECT chunk_id, distance FROM chunks_vec WHERE embedding MATCH ? AND k = ? AND scope = ?${namespaceSql}`);
    const ceiling = Math.min(k * KNN_MAX_WIDEN, VEC0_MAX_K);
    for (const scope of filter.scopes) {
      for (let want = Math.min(k * 2, VEC0_MAX_K); ; want = Math.min(want * 4, VEC0_MAX_K)) {
        const rows = statement.all(toBlob(query), BigInt(want), scope, ...(filter.namespaces ?? [])) as Array<{ chunk_id: number; distance: number }>;
        const fetched = rows.map((row) => ({ chunkId: Number(row.chunk_id), distance: row.distance }));
        const allowed = new Set(this.filterChunkIds(fetched.map((hit) => hit.chunkId), filter));
        const kept = fetched.filter((hit) => allowed.has(hit.chunkId));
        // vec0 caps k at VEC0_MAX_K, so once `want` reaches the ceiling we take what the row filter kept rather than ask for more.
        if (kept.length >= k || rows.length < want || want >= ceiling) {
          hits.push(...kept);
          break;
        }
      }
    }
    return hits.sort((a, b) => a.distance - b.distance).slice(0, k);
  }

  fts(query: string, filter: LegFilter, k: number): FtsHit[] {
    const where = whereClause(filter);
    const rows = this.db.prepare(`SELECT c.id AS chunk_id, bm25(chunks_fts, 1.0, 4.0, 2.0) AS rank
      FROM chunks_fts JOIN chunks c ON c.id = chunks_fts.rowid JOIN entries e ON e.entry_id = c.entry_id
      WHERE chunks_fts MATCH ? AND ${where.sql} ORDER BY rank LIMIT ?`).all(query, ...where.params, k) as Array<{ chunk_id: number; rank: number }>;
    return rows.map((row) => ({ chunkId: row.chunk_id, rank: row.rank }));
  }

  private filterChunkIds(ids: number[], filter: LegFilter): number[] {
    if (ids.length === 0) {
      return [];
    }
    const where = whereClause(filter);
    const rows = this.db.prepare(`SELECT c.id FROM chunks c JOIN entries e ON e.entry_id = c.entry_id
      WHERE c.id IN (${placeholders(ids)}) AND ${where.sql}`).all(...ids, ...where.params) as Array<{ id: number }>;
    return rows.map((row) => row.id);
  }

  getChunks(ids: number[]): IndexChunkRow[] {
    if (ids.length === 0) {
      return [];
    }
    const rows = this.db.prepare(`${CHUNK_SELECT} WHERE c.id IN (${placeholders(ids)})`).all(...ids) as unknown as RawChunkRow[];
    const byId = new Map(rows.map((row) => [row.chunk_id, toChunkRow(row)]));
    return ids.map((id) => byId.get(id)).filter((row): row is IndexChunkRow => row !== undefined);
  }

  recordRecall(rows: RecallRow[]): void {
    if (rows.length === 0) {
      return;
    }
    const now = Date.now();
    const insert = this.db.prepare('INSERT INTO recall(query_hash, agent, chunk_id, entry_id, rank, at_ms) VALUES (?,?,?,?,?,?)');
    this.transaction(() => {
      for (const row of rows) {
        insert.run(row.queryHash, row.agent, row.chunkId, row.entryId, row.rank, now);
      }
    });
  }

  cacheGet(key: string): Float32Array | null {
    const row = this.db.prepare('SELECT vec FROM embed_cache WHERE key = ?').get(key) as { vec: Uint8Array } | undefined;
    return row ? fromBlob(row.vec) : null;
  }

  cachePut(key: string, vector: Float32Array): void {
    this.db.prepare('INSERT OR REPLACE INTO embed_cache(key, vec, at_ms) VALUES (?,?,?)').run(key, toBlob(vector), Date.now());
  }

  /** Run `copy` with another brain database attached as `previous`; nothing happens when there is no such file. */
  private withPrevious(path: string, copy: (hasTable: (name: string) => boolean) => void): void {
    if (path === ':memory:' || !existsSync(path)) {
      return;
    }
    this.db.prepare('ATTACH DATABASE ? AS previous').run(path);
    try {
      const lookup = this.db.prepare("SELECT 1 AS found FROM previous.sqlite_master WHERE type = 'table' AND name = ?");
      copy((name) => lookup.get(name) !== undefined);
    } finally {
      this.db.exec('DETACH DATABASE previous');
    }
  }

  /**
   * Copy another brain database's embedding cache into this one. Cache keys carry the model and dimensions, so rows
   * from another identity are simply never hit; a rebuild with an unchanged model re-embeds nothing.
   */
  adoptCacheFrom(path: string): void {
    this.withPrevious(path, (hasTable) => {
      if (hasTable('embed_cache')) {
        this.db.exec('INSERT OR IGNORE INTO embed_cache(key, vec, at_ms) SELECT key, vec, at_ms FROM previous.embed_cache');
      }
    });
  }

  /**
   * Carry another brain database's recall history into this one once the entries and chunks are rebuilt. A rebuild
   * reassigns chunk ids, so each row is re-pointed at the chunk holding the same ordinal of the same entry; a row
   * whose chunk no longer exists keeps its entry with chunk id 0. Nothing is dropped: this history describes how
   * agents used the brain, not what it holds. `sinceMs` limits the copy to rows recorded from that instant, for the
   * second pass over a retired file.
   */
  adoptRecallFrom(path: string, sinceMs = 0): void {
    this.withPrevious(path, (hasTable) => {
      if (hasTable('recall') && hasTable('chunks')) {
        this.db.prepare(`INSERT INTO recall(query_hash, agent, chunk_id, entry_id, rank, at_ms)
          SELECT r.query_hash, r.agent, COALESCE(c.id, 0), r.entry_id, r.rank, r.at_ms
          FROM previous.recall AS r
          LEFT JOIN previous.chunks AS pc ON pc.id = r.chunk_id
          LEFT JOIN chunks AS c ON c.entry_id = r.entry_id AND c.ord = pc.ord
          WHERE r.at_ms >= ?
            AND NOT EXISTS (SELECT 1 FROM recall e WHERE e.query_hash = r.query_hash AND e.agent = r.agent AND e.entry_id = r.entry_id AND e.rank = r.rank AND e.at_ms = r.at_ms)
          ORDER BY r.id`).run(sinceMs);
      }
    });
  }

  /** Recall rows recorded at or after `atMs`, oldest first. */
  recallSince(atMs = 0): Array<RecallRow & { atMs: number }> {
    const rows = this.db.prepare('SELECT query_hash, agent, chunk_id, entry_id, rank, at_ms FROM recall WHERE at_ms >= ? ORDER BY id').all(atMs) as Array<{ query_hash: string; agent: string; chunk_id: number; entry_id: string; rank: number; at_ms: number }>;
    return rows.map((r) => ({ queryHash: r.query_hash, agent: r.agent, chunkId: r.chunk_id, entryId: r.entry_id, rank: r.rank, atMs: r.at_ms }));
  }

  counts(): { entries: number; chunks: number } {
    const entries = (this.db.prepare('SELECT COUNT(*) AS n FROM entries').get() as { n: number }).n;
    const chunks = (this.db.prepare('SELECT COUNT(*) AS n FROM chunks').get() as { n: number }).n;
    return { entries, chunks };
  }

  /**
   * Mark one operation that keeps using this handle across an await (a search or an index write waiting on the
   * embedder). The returned release lets a retired handle close once the last such user is done.
   */
  retain(): () => void {
    this.inFlight += 1;
    let released = false;
    return () => {
      if (released) {
        return;
      }
      released = true;
      this.inFlight -= 1;
      if (this.inFlight === 0 && this.onIdle) {
        const done = this.onIdle;
        this.onIdle = null;
        done();
      }
    };
  }

  /** Close once every retained user has released, then run `cleanup`; immediate when nothing is in flight. */
  retire(cleanup?: () => void): void {
    const done = (): void => {
      this.db.close();
      cleanup?.();
    };
    if (this.inFlight === 0) {
      done();
      return;
    }
    this.onIdle = done;
  }

  close(): void {
    this.db.close();
  }
}

/**
 * `node:sqlite` shipped unflagged in Node 22.13. Resolving it when an index opens, not when this module loads, turns
 * an older Node into one clear error. Node still prints an ExperimentalWarning the first time the module loads; that
 * one warning is dropped, every other warning is left alone.
 */
interface SqliteModule { DatabaseSync: typeof DatabaseSync }

function loadSqlite(): SqliteModule {
  const emitWarning = process.emitWarning;
  process.emitWarning = ((warning: string | Error, ...rest: unknown[]) => {
    const message = typeof warning === 'string' ? warning : warning.message;
    if (message.startsWith('SQLite is an experimental feature')) {
      return;
    }
    (emitWarning as (...args: unknown[]) => void).call(process, warning, ...rest);
  }) as typeof process.emitWarning;
  let sqlite: SqliteModule | undefined;
  try {
    sqlite = process.getBuiltinModule('node:sqlite') as SqliteModule | undefined;
  } catch {
    // Node before 22.3 has no loader at all, and older ones reject the id.
  } finally {
    process.emitWarning = emitWarning;
  }
  if (!sqlite) {
    throw new Error('node:sqlite is unavailable; the brain index needs Node 22.13 or newer');
  }
  return sqlite;
}

/**
 * The index holds verbatim chunks of every entry, so it is the owner's alone: a directory created for it is 0700, the
 * file is created 0600 (SQLite gives its -wal and -shm files the database file's mode) and an existing one is
 * tightened to 0600.
 */
function privateFile(path: string): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  writeFileSync(path, '', { flag: 'a', mode: 0o600 });
  if (process.platform !== 'win32' && (statSync(path).mode & 0o077) !== 0) {
    try {
      chmodSync(path, 0o600);
    } catch {
      // Not the file's owner: leave it as it is.
    }
  }
}

export function openBrainIndex(opts: { path: string; identity: IndexIdentity }): BrainIndex {
  const { DatabaseSync } = loadSqlite();
  if (opts.path !== ':memory:') {
    privateFile(opts.path);
  }
  const db = new DatabaseSync(opts.path, { allowExtension: true });
  sqliteVec.load(db);
  db.enableLoadExtension(false);
  const { created } = ensureSchema(db, opts.identity);
  const stored = readIdentity(db);
  const stale = !created && (stored === null || !identityMatches(stored, opts.identity) || readSchemaVersion(db) !== SCHEMA_VERSION);
  return new BrainIndex(db, stale);
}
