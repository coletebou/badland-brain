import { delimiter } from 'node:path';

import { HEADING, closesFence, fenceOpener } from '../brain/chunk.js';
import { type BrainKind, MAX_BODY_CHARS, MAX_TITLE_CHARS } from '../brain/model.js';
import { findSecretShapes } from '../brain/redact.js';
import type { BrainStore } from '../brain/store.js';
import { MAX_IMPORT_ITEMS, brainImportItemSchema } from '../mcp/schemas.js';

export interface ImportItem {
  externalId: string;
  title: string;
  body: string;
  kind: BrainKind;
  tags: string[];
  namespace: string;
  originClass: 'owner' | 'agent' | 'untrusted';
  capturedAt?: Date;
  path?: string;
  /** Set on each part of an item split for size (see splitOversize): how many parts the item has now. */
  parts?: number;
}

export interface ScanOptions {
  paths: string[];
  /** True for a path, directory, working directory or namespace that must never be imported. */
  exclude: (path: string) => boolean;
  /** Directories that hold repositories, used to name a repo namespace from a path inside one. */
  repoRoots: string[];
}

export interface Importer {
  readonly source: string;
  scan(opts: ScanOptions): AsyncIterable<ImportItem>;
}

export interface ImportSinkResult {
  created: number;
  skipped: number;
  /** Entries forgotten because their item no longer has that part (see BrainStore.retireObsoleteParts). */
  retired?: number;
  rejected: Array<{ externalId: string; error: string }>;
}

export interface ImportSink {
  put(source: string, originClass: ImportItem['originClass'], items: ImportItem[]): Promise<ImportSinkResult>;
}

export interface ImportSummary {
  scanned: number;
  excluded: number;
  /** Scanned items too long for one entry, sent as ordered parts; created and skipped count each part. */
  split: number;
  created: number;
  skipped: number;
  /** Entries forgotten because their item shrank to fewer parts, or crossed the size limit either way. */
  retired: number;
  rejected: number;
}

const escapeRegex = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');

/**
 * A matcher for exclusion terms. A term matches when it appears in a path as a whole word, words being separated by
 * `/ \ : - . _` or whitespace, case-insensitively: `acme` excludes `/src/acme/notes.md`, `-home-u-src-acme`,
 * `repo:acme` and `acme-1234-fix`, but not `acmetools`. There are no built-in terms.
 */
export function buildExcludeMatcher(terms: readonly string[]): (path: string) => boolean {
  const cleaned = [...new Set(terms.map((term) => term.trim()).filter((term) => term.length > 0))];
  for (const term of cleaned) {
    if (term.length > 100) {
      throw new Error('an exclusion term is longer than 100 characters');
    }
  }
  if (cleaned.length === 0) {
    return () => false;
  }
  const pattern = new RegExp(`(?:^|[\\\\/:._\\s-])(?:${cleaned.map(escapeRegex).join('|')})(?=[\\\\/:._\\s-]|$)`, 'iu');
  return (path) => pattern.test(path);
}

/** `My Repo` → `repo:my-repo`, `claude-code` → `repo:claude-code`. */
export const repoNamespace = (repoDirName: string): string => {
  const slug = repoDirName.toLowerCase().replace(/[^a-z0-9-]+/gu, '-').replace(/^-+|-+$/gu, '').slice(0, 64).replace(/-+$/u, '');
  return slug.length > 0 ? `repo:${slug}` : 'shared';
};

const splitList = (raw: string | undefined, separator: string): string[] =>
  (raw ?? '').split(separator).map((part) => part.trim()).filter((part) => part.length > 0);

/**
 * Where a local importer scans: every `--path` given, else the PATH-style (`:`-separated on POSIX) list in
 * `BRAIN_IMPORT_PATHS`. There is no baked-in default: memory layouts differ per machine and per person.
 */
export function resolveImportPaths(flagged: readonly string[], env: Record<string, string | undefined>): string[] {
  return flagged.length > 0 ? [...flagged] : splitList(env.BRAIN_IMPORT_PATHS, delimiter);
}

/** Exclusion terms: the comma-separated `BRAIN_IMPORT_EXCLUDE` plus every `--exclude`. Empty by default. */
export function resolveExcludeTerms(flagged: readonly string[], env: Record<string, string | undefined>): string[] {
  return [...splitList(env.BRAIN_IMPORT_EXCLUDE, ','), ...flagged];
}

/** Repo roots: the PATH-style `BRAIN_IMPORT_REPO_ROOTS` plus every `--repo-root`. */
export function resolveRepoRoots(flagged: readonly string[], env: Record<string, string | undefined>): string[] {
  return [...splitList(env.BRAIN_IMPORT_REPO_ROOTS, delimiter), ...flagged];
}

/** Parts of an item over MAX_BODY_CHARS aim this far below the cap rather than at it. */
export const IMPORT_PART_CHARS = 90_000;

/** `end`, or one less when cutting there would separate the two halves of a surrogate pair. */
export const pairSafeEnd = (text: string, end: number): number => {
  const code = text.charCodeAt(end - 1);
  return code >= 0xd800 && code <= 0xdbff ? end - 1 : end;
};

/**
 * Cut `body` into ordered parts of at most `maxChars` that concatenate back to it. Each cut is the best line start in
 * the back half of its window: a heading, then the line after a blank one (both outside fenced code), then any line,
 * and only when the window holds no line break, mid-line. The cuts depend only on the text before them, so the same
 * body always yields the same parts and a file that grows at the end keeps its earlier parts.
 */
export function splitBody(body: string, maxChars = IMPORT_PART_CHARS): string[] {
  const starts: Array<{ at: number; rank: number }> = [];
  let fence: string | null = null;
  let afterBlank = false;
  let offset = 0;
  for (const line of body.split('\n')) {
    if (offset > 0) {
      starts.push({ at: offset, rank: fence ? 1 : HEADING.test(line) ? 3 : afterBlank ? 2 : 1 });
    }
    afterBlank = line.trim() === '';
    if (fence) {
      if (closesFence(line, fence)) {
        fence = null;
      }
    } else {
      fence = fenceOpener(line);
    }
    offset += line.length + 1;
  }
  const parts: string[] = [];
  let start = 0;
  let next = 0;
  while (body.length - start > maxChars) {
    const end = start + maxChars;
    const floor = start + Math.floor(maxChars / 2);
    while (next < starts.length && starts[next].at <= floor) {
      next += 1;
    }
    let best: { at: number; rank: number } | undefined;
    for (let i = next; i < starts.length && starts[i].at <= end; i += 1) {
      if (!best || starts[i].rank >= best.rank) {
        best = starts[i];
      }
    }
    const hard = pairSafeEnd(body, end);
    const cut = best?.at ?? (hard > start ? hard : end);
    parts.push(body.slice(start, cut));
    start = cut;
  }
  parts.push(body.slice(start));
  return parts;
}

/**
 * The import route refuses a whole request when one body is over MAX_BODY_CHARS, so such an item travels as ordered
 * parts: `<externalId>#part-<n>`, titled `<title> (part n/N)`, carrying `parts: N`, every other field shared. An item
 * that fits comes back unchanged, keeping the identity its earlier imports used. The server retires the identities an
 * item no longer has, so a file that shrinks or crosses the limit leaves no stale part current.
 */
export function splitOversize(item: ImportItem): ImportItem[] {
  if (item.body.length <= MAX_BODY_CHARS) {
    return [item];
  }
  const bodies = splitBody(item.body);
  const title = item.title.trim();
  return bodies.map((body, i) => {
    const suffix = ` (part ${i + 1}/${bodies.length})`;
    const room = MAX_TITLE_CHARS - suffix.length;
    const base = title.length > room ? title.slice(0, pairSafeEnd(title, room)).trimEnd() : title;
    return { ...item, externalId: `${item.externalId}#part-${i + 1}`, title: `${base}${suffix}`, body, parts: bodies.length };
  });
}

export async function runImport(
  importer: Importer,
  sink: ImportSink,
  opts: {
    paths: string[];
    dryRun: boolean;
    exclude?: (path: string) => boolean;
    repoRoots?: string[];
    /** Put every item in this namespace instead of the one the importer derived. */
    namespace?: string;
    batchSize?: number;
    log?: (line: string) => void;
    /** Told about every rejected item or part, with the reason the log line carries. */
    onReject?: (externalId: string, error: string) => void;
  },
): Promise<ImportSummary> {
  const batchSize = opts.batchSize ?? 50;
  const log = opts.log ?? (() => undefined);
  const exclude = opts.exclude ?? (() => false);
  const summary: ImportSummary = { scanned: 0, excluded: 0, split: 0, created: 0, skipped: 0, retired: 0, rejected: 0 };
  const batches = new Map<ImportItem['originClass'], ImportItem[]>();

  const reject = (externalId: string, error: string): void => {
    summary.rejected += 1;
    log(`rejected ${externalId}: ${error}`);
    opts.onReject?.(externalId, error);
  };

  const flush = async (originClass: ImportItem['originClass']): Promise<void> => {
    const items = batches.get(originClass) ?? [];
    if (items.length === 0) {
      return;
    }
    batches.set(originClass, []);
    if (opts.dryRun) {
      log(`[dry-run] would import ${items.length} ${originClass} item(s) from ${importer.source}`);
      return;
    }
    const result = await sink.put(importer.source, originClass, items);
    summary.created += result.created;
    summary.skipped += result.skipped;
    summary.retired += result.retired ?? 0;
    for (const rejected of result.rejected) {
      reject(rejected.externalId, rejected.error);
    }
  };

  for await (const scanned of importer.scan({ paths: opts.paths, exclude, repoRoots: opts.repoRoots ?? [] })) {
    summary.scanned += 1;
    const item = opts.namespace ? { ...scanned, namespace: opts.namespace } : scanned;
    if (exclude(item.path ?? item.externalId) || exclude(item.externalId) || exclude(item.namespace)) {
      summary.excluded += 1;
      continue;
    }
    if (item.body.trim().length === 0) {
      reject(item.externalId, 'empty body');
      continue;
    }
    let parts = [item];
    if (item.body.length > MAX_BODY_CHARS) {
      // The store gates each part on its own, which a cut can defeat: a key split across two parts, or a private key
      // whose BEGIN line (all its pattern matches) lands in one part and the key itself in the next. So the whole body
      // passes the gate here first, and a match rejects the whole item, as the store does for an item that fits.
      const secret = findSecretShapes(item.body)[0];
      if (secret) {
        reject(item.externalId, `body contains a secret-shaped value: ${secret}`);
        continue;
      }
      parts = splitOversize(item);
      summary.split += 1;
      log(`split ${item.externalId} (${item.body.length} chars) into ${parts.length} parts`);
    }
    for (const part of parts) {
      const batch = batches.get(part.originClass) ?? [];
      batch.push(part);
      batches.set(part.originClass, batch);
      if (batch.length >= batchSize) {
        await flush(part.originClass);
      }
    }
  }
  for (const originClass of batches.keys()) {
    await flush(originClass);
  }
  return summary;
}

/** The server parses at most 10 MB per import request; a request of near-cap parts stays well under that. */
const MAX_REQUEST_BYTES = 8 * 1024 * 1024;

const toWire = (item: ImportItem) => ({
  externalId: item.externalId, title: item.title, body: item.body, kind: item.kind, tags: item.tags, namespace: item.namespace,
  capturedAt: item.capturedAt?.toISOString(), path: item.path, parts: item.parts,
});
type WireItem = ReturnType<typeof toWire>;

/**
 * Ship items to the server's bulk import route with an owner key. The route refuses a whole request over one item its
 * schema rejects, so each item is checked against that schema here and a bad one is rejected alone; the rest go out in
 * as many requests as the server's item and body limits need.
 */
export function createApiSink(options: { origin: string; key: string; fetchImpl?: typeof fetch; maxRequestBytes?: number }): ImportSink {
  const fetchImpl = options.fetchImpl ?? fetch;
  const maxRequestBytes = options.maxRequestBytes ?? MAX_REQUEST_BYTES;
  const base = options.origin.replace(/\/+$/u, '');
  const post = async (source: string, originClass: ImportItem['originClass'], items: WireItem[]): Promise<ImportSinkResult> => {
    const response = await fetchImpl(`${base}/api/import`, {
      method: 'POST',
      headers: { authorization: `Bearer ${options.key}`, 'content-type': 'application/json', 'x-brain-source': source },
      body: JSON.stringify({ originClass, items }),
    });
    const body = (await response.json().catch(() => null)) as { ok: boolean; data?: ImportSinkResult; error?: string } | null;
    if (!response.ok) {
      throw new Error(`import request failed with ${response.status}${body?.error ? `: ${body.error}` : ''}`);
    }
    if (!body?.ok || !body.data) {
      throw new Error(body?.error ?? 'import request returned an unexpected response');
    }
    return body.data;
  };
  return {
    async put(source, originClass, items) {
      const result: ImportSinkResult = { created: 0, skipped: 0, retired: 0, rejected: [] };
      let request: WireItem[] = [];
      let bytes = 0;
      const send = async (): Promise<void> => {
        if (request.length === 0) {
          return;
        }
        const sent = await post(source, originClass, request);
        result.created += sent.created;
        result.skipped += sent.skipped;
        result.retired = (result.retired ?? 0) + (sent.retired ?? 0);
        result.rejected.push(...sent.rejected);
        request = [];
        bytes = 0;
      };
      for (const item of items) {
        // An invalid Date has no ISO form and would throw below, ending the whole run.
        if (item.capturedAt && Number.isNaN(item.capturedAt.getTime())) {
          result.rejected.push({ externalId: item.externalId, error: 'capturedAt: invalid date' });
          continue;
        }
        const wire = toWire(item);
        const checked = brainImportItemSchema.safeParse(wire);
        if (!checked.success) {
          const issue = checked.error.issues[0];
          result.rejected.push({ externalId: item.externalId, error: issue ? `${issue.path.join('.')}: ${issue.message}` : 'invalid import item' });
          continue;
        }
        const size = Buffer.byteLength(JSON.stringify(wire));
        if (request.length >= MAX_IMPORT_ITEMS || (request.length > 0 && bytes + size > maxRequestBytes)) {
          await send();
        }
        request.push(wire);
        bytes += size;
      }
      await send();
      return result;
    },
  };
}

/** Write straight into a store in this process, as the import route does; tests use it. */
export function createStoreSink(options: { store: BrainStore; agent: string }): ImportSink {
  return {
    async put(source, originClass, items) {
      const result: ImportSinkResult = { created: 0, skipped: 0, retired: 0, rejected: [] };
      for (const item of items) {
        try {
          const actor = { agent: options.agent, originClass };
          const { created } = await options.store.note(actor, {
            title: item.title, body: item.body, kind: item.kind, tags: item.tags, namespace: item.namespace, validFrom: item.capturedAt,
            source: { system: source, externalId: item.externalId, path: item.path, capturedAt: item.capturedAt },
          });
          result[created ? 'created' : 'skipped'] += 1;
          result.retired = (result.retired ?? 0) + await options.store.retireObsoleteParts(actor, { system: source, externalId: item.externalId }, item.parts);
        } catch (error) {
          result.rejected.push({ externalId: item.externalId, error: (error as Error).message.slice(0, 200) });
        }
      }
      return result;
    },
  };
}
