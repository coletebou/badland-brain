/**
 * Bearer keys. A key is 256 random bits; only its sha256 is stored, in a JSON keys file (hot-reloaded when it
 * changes) and/or inline in BRAIN_KEYS. Each key has exactly one role:
 *
 *   read   the four read tools: search, get, list, context
 *   agent  the read tools plus note, supersede and forget; writes are episodic, attributed to the key's name, origin agent
 *   owner  the operator: import with provenance, promote into the curated tier, reindex, forget a whole import source,
 *          and owner-origin corrections. Never accepted on /mcp, so a client that agents use never carries owner authority.
 *
 * A read or agent key may be confined to a list of namespaces: everything outside them reads as if it did not exist,
 * and writes outside them are refused.
 */
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

import { z } from 'zod';

import { isValidNamespace } from '../brain/model.js';
import { findSecretShapes } from '../brain/redact.js';
import { type Logger, reasonOf, silentLogger } from '../log.js';

export const KEY_ROLES = ['read', 'agent', 'owner'] as const;
export type KeyRole = (typeof KEY_ROLES)[number];

/** Every key starts with this, so secret scanners (and the brain's own write gate) recognise one. */
export const KEY_PREFIX = 'bbk_';
const KEY_PATTERN = /^bbk_[A-Za-z0-9_-]{43}$/u;
export const KEY_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9@._:+-]{0,119}$/u;
export const MAX_KEY_NAMESPACES = 32;

const recordSchema = z.object({
  id: z.string().regex(/^k_[0-9a-f]{8,32}$/u),
  name: z.string().regex(KEY_NAME_PATTERN, 'name: 1-120 of A-Z a-z 0-9 @ . _ : + -, starting with a letter or digit'),
  role: z.enum(KEY_ROLES),
  namespaces: z.array(z.string().refine(isValidNamespace, 'namespaces: shared, repo:<slug> or agent:<name>')).min(1).max(MAX_KEY_NAMESPACES).optional(),
  hash: z.string().regex(/^[0-9a-f]{64}$/u, 'hash: 64 lowercase hex characters (sha256 of the key)'),
  createdAt: z.iso.datetime({ offset: true }),
  expiresAt: z.iso.datetime({ offset: true }).optional(),
}).strict().superRefine((record, ctx) => {
  if (record.role === 'owner' && record.namespaces) {
    ctx.addIssue({ code: 'custom', message: 'an owner key cannot be confined to namespaces', path: ['namespaces'] });
  }
  if (record.namespaces && new Set(record.namespaces).size !== record.namespaces.length) {
    ctx.addIssue({ code: 'custom', message: 'namespaces must not repeat', path: ['namespaces'] });
  }
  if (findSecretShapes(record.name).length > 0) {
    ctx.addIssue({ code: 'custom', message: 'name looks like a secret', path: ['name'] });
  }
});
export type KeyRecord = z.infer<typeof recordSchema>;

const fileSchema = z.union([z.object({ version: z.literal(1), keys: z.array(z.unknown()) }).strict(), z.array(z.unknown())]);

export const hashKey = (raw: string): string => createHash('sha256').update(raw).digest('hex');
export const isKeyShaped = (raw: string): boolean => KEY_PATTERN.test(raw);

/** Parse a keys document (the file's `{ version, keys }` or a bare array). Throws naming the first bad field, never a value. */
export function parseKeys(text: string, origin: string): KeyRecord[] {
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    throw new Error(`${origin} is not valid JSON`);
  }
  const shape = fileSchema.safeParse(json);
  if (!shape.success) {
    throw new Error(`${origin} must be {"version": 1, "keys": [...]} or an array of keys`);
  }
  const rows = Array.isArray(shape.data) ? shape.data : shape.data.keys;
  const records = rows.map((row, i) => {
    const parsed = recordSchema.safeParse(row);
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      throw new Error(`${origin}: key ${i + 1}: ${issue?.path.join('.') || 'record'}: ${issue?.message ?? 'invalid'}`);
    }
    return parsed.data;
  });
  const ids = new Set<string>();
  for (const record of records) {
    if (ids.has(record.id)) {
      throw new Error(`${origin}: key id ${record.id} appears twice`);
    }
    ids.add(record.id);
  }
  return records;
}

export type KeyLookup =
  | { ok: true; key: KeyRecord }
  | { ok: false; reason: 'unknown' | 'expired' | 'unavailable' };

interface FileState { signature: string; records: KeyRecord[]; error: string | null }

/**
 * The keys this server accepts: an inline set fixed at startup plus the keys file, re-read whenever its size, mtime
 * or inode changes, so minting or revoking needs no restart. A keys file that exists but cannot be parsed fails
 * closed: none of its keys work until it is fixed (inline keys keep working).
 */
export class KeyStore {
  private readonly inline: KeyRecord[];
  private fileState: FileState = { signature: '', records: [], error: null };
  private loggedError: string | null = null;

  constructor(private readonly opts: { file?: string; inline?: string; logger?: Logger; now?: () => Date }) {
    this.inline = opts.inline?.trim() ? parseKeys(opts.inline, 'BRAIN_KEYS') : [];
    this.refresh();
  }

  private get logger(): Logger {
    return this.opts.logger ?? silentLogger;
  }

  private refresh(): void {
    const file = this.opts.file;
    if (!file) {
      return;
    }
    let signature = 'missing';
    let mode = 0;
    try {
      const info = statSync(file);
      signature = `${info.ino}:${info.size}:${info.mtimeMs}`;
      mode = info.mode;
    } catch {
      // A missing file is an empty one.
    }
    if (signature === this.fileState.signature) {
      return;
    }
    if (signature === 'missing') {
      this.fileState = { signature, records: [], error: null };
      return;
    }
    try {
      const records = parseKeys(readFileSync(file, 'utf8'), 'keys file');
      if ((mode & 0o077) !== 0 && process.platform !== 'win32') {
        this.logger.warn('keys file is readable by other users; run chmod 600 on it', { file });
      }
      this.fileState = { signature, records, error: null };
      this.loggedError = null;
      this.logger.info('keys loaded', { file, keys: records.length });
    } catch (error) {
      const reason = reasonOf(error);
      this.fileState = { signature, records: [], error: reason };
      if (this.loggedError !== reason) {
        this.loggedError = reason;
        this.logger.error('keys file rejected; none of its keys are accepted until it is fixed', { file, reason });
      }
    }
  }

  /** Every accepted key record: inline first, then the file's. */
  list(): KeyRecord[] {
    this.refresh();
    return [...this.inline, ...this.fileState.records];
  }

  /** The file's parse error, if it has one. */
  fileError(): string | null {
    this.refresh();
    return this.fileState.error;
  }

  lookup(raw: string): KeyLookup {
    if (!isKeyShaped(raw)) {
      return { ok: false, reason: 'unknown' };
    }
    const presented = Buffer.from(hashKey(raw), 'hex');
    const match = this.list().find((record) => timingSafeEqual(Buffer.from(record.hash, 'hex'), presented));
    if (!match) {
      return { ok: false, reason: 'unknown' };
    }
    const now = (this.opts.now ?? (() => new Date()))().getTime();
    if (match.expiresAt && Date.parse(match.expiresAt) <= now) {
      return { ok: false, reason: 'expired' };
    }
    return { ok: true, key: match };
  }
}

/** A new key and the record that stores its hash. The raw key is shown once and never stored. */
export function mintKey(opts: { name: string; role: KeyRole; namespaces?: string[]; expiresDays?: number; now?: Date }): { raw: string; record: KeyRecord } {
  const now = opts.now ?? new Date();
  const raw = `${KEY_PREFIX}${randomBytes(32).toString('base64url')}`;
  const candidate = {
    id: `k_${randomBytes(6).toString('hex')}`,
    name: opts.name,
    role: opts.role,
    ...(opts.namespaces && opts.namespaces.length > 0 ? { namespaces: [...new Set(opts.namespaces)] } : {}),
    hash: hashKey(raw),
    createdAt: now.toISOString(),
    ...(opts.expiresDays !== undefined ? { expiresAt: new Date(now.getTime() + opts.expiresDays * 86_400_000).toISOString() } : {}),
  };
  const parsed = recordSchema.safeParse(candidate);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    throw new Error(`${issue?.path.join('.') || 'key'}: ${issue?.message ?? 'invalid'}`);
  }
  return { raw, record: parsed.data };
}

/** The records in a keys file; a missing file is empty. */
export function readKeysFile(file: string): KeyRecord[] {
  return existsSync(file) ? parseKeys(readFileSync(file, 'utf8'), 'keys file') : [];
}

/** Replace the keys file atomically (temp file plus rename), owner-only permissions, its directory created 0700. */
export function writeKeysFile(file: string, records: KeyRecord[]): void {
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  const temp = `${file}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
  writeFileSync(temp, `${JSON.stringify({ version: 1, keys: records }, null, 2)}\n`, { mode: 0o600 });
  chmodSync(temp, 0o600);
  renameSync(temp, file);
}

export function addKey(file: string, record: KeyRecord): void {
  const records = readKeysFile(file);
  if (records.some((existing) => existing.name === record.name)) {
    throw new Error(`a key named ${record.name} already exists; revoke it first or choose another name`);
  }
  writeKeysFile(file, [...records, record]);
}

/** Remove the keys whose id matches, or whose name matches when the name is unique. Returns what was removed. */
export function revokeKey(file: string, idOrName: string): KeyRecord[] {
  const records = readKeysFile(file);
  const byId = records.filter((record) => record.id === idOrName);
  const byName = records.filter((record) => record.name === idOrName);
  if (byId.length === 0 && byName.length > 1) {
    throw new Error(`${byName.length} keys are named ${idOrName}; revoke one by id`);
  }
  const removed = byId.length > 0 ? byId : byName;
  if (removed.length > 0) {
    writeKeysFile(file, records.filter((record) => !removed.includes(record)));
  }
  return removed;
}
