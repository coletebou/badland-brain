import { createHash, randomBytes } from 'node:crypto';

import {
  type BrainKind, type BrainOriginClass, type BrainTier, type IBrainEntryDocument, type IBrainSource,
  MAX_AUTHOR_AGENT_CHARS, MAX_TAGS, MAX_USER_TAGS,
} from './model.js';
import { findSecretShapes } from './redact.js';

export class BrainInputError extends Error {}
export class BrainNotFoundError extends Error {}
export class BrainConflictError extends Error {
  constructor(readonly currentHash: string) {
    super(`content hash mismatch; the current hash is ${currentHash}`);
  }
}

/** Who is writing. `originClass` is derived by the caller from the write path, never from input. */
export interface BrainActor {
  agent: string;
  originClass: BrainOriginClass;
}

/**
 * The namespaces a caller may see. Absent means every namespace; a namespace-confined key passes its list, and
 * anything outside it reads exactly as if it did not exist.
 */
export interface Visibility {
  namespaces?: readonly string[];
}

export const isVisible = (namespace: string, visibility: Visibility = {}): boolean =>
  visibility.namespaces === undefined || visibility.namespaces.includes(namespace);

export interface NoteInput {
  title: string;
  body: string;
  kind: BrainKind;
  tags?: string[];
  namespace?: string;
  importance?: number;
  validFrom?: Date;
  source?: IBrainSource;
}

export interface BrainEntryView {
  slug: string;
  title: string;
  kind: BrainKind;
  tier: BrainTier;
  tags: string[];
  namespace: string;
  originClass: BrainOriginClass;
  authorAgent: string;
  importance: number;
  validFrom: string;
  invalidAt: string | null;
  createdAt: string;
  updatedAt: string;
  supersededBy: string | null;
  contentHash: string;
  bodyChars: number;
  source?: IBrainSource;
}

export interface BrainEntryRead extends BrainEntryView {
  body: string;
  offset: number;
  hasMore: boolean;
  history: Array<{ slug: string; invalidAt: string | null }>;
}

export const READ_WINDOW_CHARS = 8000;

/** The optimistic-concurrency token for supersede: sha256 of the body, hex. */
export const computeContentHash = (body: string): string => createHash('sha256').update(body).digest('hex');

/** Every caller-controlled text that is stored, returned, indexed, or embedded passes through here; only the pattern name is reported. */
export function rejectSecrets(field: string, text: string): void {
  const secrets = findSecretShapes(text);
  if (secrets.length > 0) {
    throw new BrainInputError(`${field} contains a secret-shaped value: ${secrets[0]}`);
  }
}

/**
 * Attribution for entries an importer writes on behalf of an owner key. Key names may use the whole schema limit
 * themselves, so the composed value is cut to it rather than failing every item.
 */
export function importerAgent(keyName: string): string {
  return `importer:${keyName}`.slice(0, MAX_AUTHOR_AGENT_CHARS);
}

export const MAX_TAG_CHARS = 50;

/** Readable, unique enough: kebab title (≤48 chars) plus six hex characters. */
export function makeSlug(title: string): string {
  const base = title
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^\p{L}\p{N}]+/gu, '-')
    .replace(/^-+|-+$/gu, '')
    .slice(0, 48)
    .replace(/-+$/u, '');
  return `${base.length > 0 ? base : 'entry'}-${randomBytes(3).toString('hex')}`;
}

export function toView(doc: IBrainEntryDocument, supersededBySlug: string | null): BrainEntryView {
  const view: BrainEntryView = {
    slug: doc.slug,
    title: doc.title,
    kind: doc.kind,
    tier: doc.tier,
    tags: [...doc.tags],
    namespace: doc.namespace,
    originClass: doc.originClass,
    authorAgent: doc.authorAgent,
    importance: doc.importance,
    validFrom: doc.validFrom.toISOString(),
    invalidAt: doc.invalidAt ? doc.invalidAt.toISOString() : null,
    createdAt: doc.createdAt.toISOString(),
    updatedAt: doc.updatedAt.toISOString(),
    supersededBy: supersededBySlug,
    contentHash: doc.contentHash,
    bodyChars: doc.body.length,
  };
  if (doc.source) {
    const { system, externalId, path, url, capturedAt } = doc.source;
    view.source = { system, externalId, ...(path !== undefined ? { path } : {}), ...(url !== undefined ? { url } : {}), ...(capturedAt !== undefined ? { capturedAt } : {}) };
  }
  return view;
}

/** Trim, drop empties, dedupe, and bound tags; throws on oversize. */
export function normalizeTags(tags: string[] | undefined): string[] {
  const seen = new Set<string>();
  for (const raw of tags ?? []) {
    const tag = raw.trim();
    if (tag.length === 0) {
      continue;
    }
    if (tag.length > MAX_TAG_CHARS) {
      throw new BrainInputError(`tag exceeds ${MAX_TAG_CHARS} characters`);
    }
    seen.add(tag);
  }
  if (seen.size > MAX_USER_TAGS) {
    throw new BrainInputError(`at most ${MAX_USER_TAGS} tags`);
  }
  return [...seen];
}

/**
 * Compose a stored tag set from a base plus the store's own system tags (standing, needs-review),
 * deduped and bounded at MAX_TAGS. Never throws: system tags are always kept, and if the total would
 * exceed the cap the oldest non-system tags are dropped. Callers are capped at MAX_USER_TAGS, so with
 * two system slots this never actually trims a well-formed entry.
 */
export function withSystemTags(baseTags: string[], ...systemTags: string[]): string[] {
  const system = new Set(systemTags.map((tag) => tag.trim()).filter((tag) => tag.length > 0));
  const seen = new Set<string>();
  for (const raw of [...baseTags, ...system]) {
    const tag = raw.trim();
    if (tag.length === 0 || tag.length > MAX_TAG_CHARS) {
      continue;
    }
    seen.add(tag);
  }
  const all = [...seen];
  if (all.length <= MAX_TAGS) {
    return all;
  }
  const users = all.filter((tag) => !system.has(tag));
  const systems = all.filter((tag) => system.has(tag));
  return [...users.slice(users.length - (MAX_TAGS - systems.length)), ...systems];
}
