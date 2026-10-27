import type { Types } from 'mongoose';

import type { BrainConfig } from './config.js';
import type { Embedder } from './embeddings/index.js';
import type { BrainIndex } from './index/sqlite.js';
import {
  BrainEntry,
  type BrainKind,
  type BrainTier,
  type IBrainEntry,
  type IBrainEntryDocument,
  type IBrainSource,
  MAX_BODY_CHARS,
  MAX_TITLE_CHARS,
  RESERVED_LINEAGE_SYSTEMS,
  isValidNamespace,
} from './model.js';
import { type IndexDeps, indexDocument } from './store-index.js';
import {
  type BrainActor,
  BrainConflictError,
  type BrainEntryRead,
  type BrainEntryView,
  BrainInputError,
  BrainNotFoundError,
  type NoteInput,
  READ_WINDOW_CHARS,
  type Visibility,
  computeContentHash,
  isVisible,
  makeSlug,
  normalizeTags,
  rejectSecrets,
  toView,
  withSystemTags,
} from './store-views.js';

export { BrainConflictError, BrainInputError, BrainNotFoundError, makeSlug, toView } from './store-views.js';
export type { BrainActor, BrainEntryRead, BrainEntryView, NoteInput, Visibility } from './store-views.js';

export interface StoreDeps {
  index: BrainIndex;
  embedder: Embedder;
  config: BrainConfig;
  now?: () => Date;
}

export interface ListFilter {
  /** Only entries in these namespaces. */
  namespaces?: readonly string[];
  kind?: BrainKind;
  tier?: BrainTier;
  since?: Date;
  /** Exact `authorAgent`. */
  authorAgent?: string;
  /** Only each entry's current version: superseded versions are left out (forgotten ones always are). */
  current?: boolean;
}
export interface PageInput { page: number; limit: number }
export interface PageResult<T> { items: T[]; page: number; limit: number; hasMore: boolean }

type CreateFields = Omit<IBrainEntry, 'slug' | 'live' | 'createdAt' | 'updatedAt'> & { live?: boolean };

const NEEDS_REVIEW_TAG = 'needs-review';
const DUPLICATE_KEY = 11000;
/** The identity suffix the importers give each part of an item split for size. */
const PART_SUFFIX = /#part-(\d+)$/u;
const escapeRegex = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');

const isDuplicateKey = (error: unknown, field: string): boolean => {
  const { code, keyPattern } = error as { code?: number; keyPattern?: Record<string, number> };
  return code === DUPLICATE_KEY && field in (keyPattern ?? {});
};

const outside = (namespace: string): BrainInputError =>
  new BrainInputError(`namespace ${namespace} is outside this key's namespaces`);

function validateInput(input: NoteInput): { title: string; body: string; tags: string[]; namespace: string; importance: number } {
  const title = input.title.trim();
  if (title.length === 0 || title.length > MAX_TITLE_CHARS) {
    throw new BrainInputError(`title must be 1-${MAX_TITLE_CHARS} characters`);
  }
  if (input.body.trim().length === 0 || input.body.length > MAX_BODY_CHARS) {
    throw new BrainInputError(`body must be 1-${MAX_BODY_CHARS} characters`);
  }
  const tags = normalizeTags(input.tags);
  rejectSecrets('body', input.body);
  rejectSecrets('title', title);
  rejectSecrets('a tag', tags.join(' '));
  const namespace = input.namespace ?? 'shared';
  if (!isValidNamespace(namespace)) {
    throw new BrainInputError('namespace must be shared, repo:<slug>, or agent:<name>');
  }
  const importance = input.importance ?? 5;
  if (!Number.isInteger(importance) || importance < 1 || importance > 10) {
    throw new BrainInputError('importance must be an integer from 1 to 10');
  }
  return { title, body: input.body, tags, namespace, importance };
}

/**
 * Every brain write goes through here, so the index never drifts from Mongo and the governed fields (tier,
 * originClass, authorAgent, time, hash) are always set by code. Every read that names an entry takes the caller's
 * visibility: an entry outside it reads exactly as one that does not exist.
 */
export class BrainStore {
  private deps: StoreDeps;
  private readonly now: () => Date;

  constructor(deps: StoreDeps) {
    this.deps = deps;
    this.now = deps.now ?? (() => new Date());
  }

  /** Point this store at a replacement index. The reindex swap calls it so requests holding the store keep writing to the live index. */
  setIndex(index: BrainIndex): void {
    this.deps = { ...this.deps, index };
  }

  private indexDeps(): IndexDeps {
    return { index: this.deps.index, embedder: this.deps.embedder, config: this.deps.config };
  }

  private async create(fields: CreateFields): Promise<IBrainEntryDocument> {
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        return await BrainEntry.create({ ...fields, slug: makeSlug(fields.title) });
      } catch (error) {
        if (!isDuplicateKey(error, 'slug')) {
          throw error;
        }
      }
    }
    throw new Error('could not allocate a unique slug');
  }

  private async live(slug: string, visibility: Visibility = {}): Promise<IBrainEntryDocument> {
    const doc = await BrainEntry.findOne({ slug });
    if (!doc || doc.forgotten || !isVisible(doc.namespace, visibility)) {
      throw new BrainNotFoundError('No entry with that slug is visible to this key.');
    }
    if (!doc.live) {
      // A retry after a replacement that failed part-way lands here: repair both versions first.
      await this.indexEntry(doc);
      const successor = await this.successorOf(doc);
      if (successor) {
        await this.ensureIndexed(successor);
      }
      throw new BrainInputError('That entry was superseded; change its current version instead.');
    }
    return doc;
  }

  /**
   * The replacement of a retired entry: the linked one, or, when the link was never saved, the live entry carrying
   * the successor's source identity (`supersede/<slug>` for a supersede, the same source for a re-import). A
   * recovered successor is linked so history reads correctly afterwards.
   */
  private async successorOf(doc: IBrainEntryDocument): Promise<IBrainEntryDocument | null> {
    if (doc.supersededBy) {
      return BrainEntry.findById(doc.supersededBy);
    }
    const identities = [{ system: 'supersede', externalId: doc.slug }, ...(doc.source ? [{ system: doc.source.system, externalId: doc.source.externalId }] : [])];
    const successor = await BrainEntry.findOne({
      live: true, forgotten: { $exists: false },
      $or: identities.map((s) => ({ 'source.system': s.system, 'source.externalId': s.externalId })),
    });
    if (successor) {
      doc.supersededBy = successor._id;
      await doc.save();
    }
    return successor;
  }

  /**
   * Everything made from `roots`, transitively, read from `source` alone: supersede copies name the slug they
   * replaced and promote copies the slug they were copied from. `supersededBy` is history, not lineage: a version
   * folded into an unrelated live twin links to that twin, but the twin is not a version of it and is never returned
   * here. Forgotten entries end a branch.
   */
  private async derived(roots: string[], systems: Array<'promote' | 'supersede'>): Promise<IBrainEntryDocument[]> {
    const seen = new Set(roots);
    const found: IBrainEntryDocument[] = [];
    let frontier = roots;
    while (frontier.length > 0) {
      // Walk THROUGH forgotten nodes so a live correction beyond an individually-forgotten intermediate version is
      // still reached (e.g. A -> B -> C where B was forgotten by slug); only non-forgotten copies join the result,
      // so `found` still means "descendants that still need retirement / are still live".
      const copies = await BrainEntry.find({ 'source.system': { $in: systems }, 'source.externalId': { $in: frontier } });
      frontier = [];
      for (const copy of copies) {
        if (!seen.has(copy.slug)) {
          seen.add(copy.slug);
          if (!copy.forgotten) {
            found.push(copy);
          }
          frontier.push(copy.slug);
        }
      }
    }
    return found;
  }

  /**
   * The versions behind an import identity: every entry the importer wrote under it plus the supersedes derived from
   * them (an agent's correction carries `supersede/<slug>`, not the identity). `imported` is the last one the
   * importer wrote, whose hash says whether the source changed since; `head` is the live version, or null when every
   * version was retired (a changed import folded onto an unrelated twin, say). Null as a whole when nothing was
   * imported under the identity. Forgotten versions stay in the walk, as in `derived`: an import's original forgotten
   * by slug must not hide the live correction made from it, or an unchanged re-import would bring the original back
   * beside it.
   */
  private async importedVersions(source: IBrainSource): Promise<{ imported: IBrainEntryDocument; head: IBrainEntryDocument | null; versions: IBrainEntryDocument[]; slugs: string[] } | null> {
    const written = await BrainEntry.find({ 'source.system': source.system, 'source.externalId': source.externalId }).sort({ createdAt: -1, _id: -1 });
    if (written.length === 0) {
      return null;
    }
    const versions = [...written, ...await this.derived(written.map((doc) => doc.slug), ['supersede'])];
    return { imported: written[0], head: versions.find((doc) => doc.live) ?? null, versions, slugs: versions.map((doc) => doc.slug) };
  }

  /** The view of an entry; its successor is named only when the caller may see it. */
  private async viewOf(doc: IBrainEntryDocument, visibility: Visibility = {}): Promise<BrainEntryView> {
    const next = doc.supersededBy ? await BrainEntry.findById(doc.supersededBy).select('slug namespace forgotten').lean() : null;
    return toView(doc, next && !next.forgotten && isVisible(next.namespace, visibility) ? next.slug : null);
  }

  async indexEntry(doc: IBrainEntryDocument): Promise<void> {
    await indexDocument(this.indexDeps(), doc);
  }

  /** Whether the live index holds this version of an entry. */
  isIndexed(entryId: string, updatedAt: Date): boolean {
    return this.deps.index.updatedAtOf(entryId) === updatedAt.getTime();
  }

  /** Repair the index for an entry whose earlier write failed between Mongo and SQLite, or whose row is older than the document. */
  private async ensureIndexed(doc: IBrainEntryDocument): Promise<void> {
    if (!doc.forgotten && !this.isIndexed(doc._id.toString(), doc.updatedAt)) {
      await this.indexEntry(doc);
    }
  }

  /** A live twin that starts later than `at` becomes true from `at`, so a fold or dedupe leaves no gap with no current version. */
  private async startNoLaterThan(doc: IBrainEntryDocument, at: Date): Promise<void> {
    if (doc.validFrom.getTime() <= at.getTime()) {
      await this.ensureIndexed(doc);
      return;
    }
    doc.validFrom = at;
    await doc.save();
    await this.indexEntry(doc);
  }

  /**
   * Retire `old` and create its replacement; the shared path behind supersede and re-import. `at` is when the new
   * version became true: now, or the capture time a re-import carries. Retiring first frees the source identity for
   * the replacement, and it is compare-and-set on `live` and the hash, so of two concurrent replacements only one
   * proceeds. When the new body already exists as a live entry in the same namespace, `old` is folded into that entry
   * instead of a duplicate being created; if creating the replacement fails for any other reason the old version is
   * put back, so a transient error never leaves a fact with no live copy.
   */
  private async replace(
    old: IBrainEntryDocument,
    actor: BrainActor,
    next: { title: string; body: string; tags: string[]; kind: BrainKind; namespace: string; importance: number; source: IBrainSource },
    at: Date = this.now(),
  ): Promise<{ entry: IBrainEntryDocument; created: boolean }> {
    const contentHash = computeContentHash(next.body);
    // A live episodic entry in the new version's namespace that already has the new body is the fold target.
    // Retiring `old` and linking it to that twin happen in one write, so a failure leaves either both or neither.
    // Only an episodic entry dedupes into a body twin; a curated entry keeps its tier when superseded, never folding into an episodic note.
    const twinBefore = old.tier === 'episodic'
      ? await BrainEntry.findOne({ contentHash, namespace: next.namespace, live: true, tier: 'episodic', forgotten: { $exists: false }, _id: { $ne: old._id } })
      : null;
    const retired = await BrainEntry.findOneAndUpdate(
      { _id: old._id, live: true, contentHash: old.contentHash },
      { $set: { live: false, invalidAt: at, expiredAt: at, ...(twinBefore ? { supersededBy: twinBefore._id } : {}) } },
      { new: true },
    );
    if (!retired) {
      const current = await BrainEntry.findById(old._id).select('contentHash').lean();
      throw new BrainConflictError(current?.contentHash ?? old.contentHash);
    }
    if (twinBefore) {
      // The fold target could have been forgotten or superseded between the read above and this retirement, which
      // just linked `old` to a now-non-live twin and would leave the lineage with no live version. Re-read the twin;
      // when it is no longer a live fold target, restore `old` (unsetting the link written above) and let the caller
      // retry, rather than fold into a dead entry.
      const twin = await BrainEntry.findOne({ _id: twinBefore._id, live: true, forgotten: { $exists: false } });
      if (!twin) {
        await this.unfoldSource(old, twinBefore._id);
        throw new BrainConflictError(old.contentHash);
      }
      await this.indexEntry(retired);
      await this.startNoLaterThan(twin, at);
      // A concurrent forget/supersede of the twin can still land during the two writes above; a final check keeps the
      // lineage from being left retired into a dead twin. The tiny residual after this check is the same
      // non-transactional two-document boundary as the store's other documented races, healed by a later write.
      if (!(await BrainEntry.exists({ _id: twin._id, live: true, forgotten: { $exists: false } }))) {
        await this.unfoldSource(old, twin._id);
        throw new BrainConflictError(old.contentHash);
      }
      return { entry: twin, created: false };
    }
    let created: IBrainEntryDocument;
    try {
      created = await this.create({
        title: next.title, body: next.body, tags: next.tags, kind: next.kind, tier: old.tier,
        namespace: next.namespace, originClass: actor.originClass, authorAgent: actor.agent, importance: next.importance,
        validFrom: at, contentHash, source: next.source,
      });
    } catch (error) {
      // A twin that appeared between the check above and the insert surfaces as a duplicate key. Any failure
      // before its link is saved undoes the retirement, so the request fails without having changed state.
      let twin: IBrainEntryDocument | null;
      try {
        twin = old.tier === 'episodic' && isDuplicateKey(error, 'contentHash')
          ? await BrainEntry.findOne({ contentHash, namespace: next.namespace, live: true, tier: 'episodic', forgotten: { $exists: false } })
          : null;
        if (twin) {
          retired.supersededBy = twin._id;
          await retired.save();
        }
      } catch (linkError) {
        await this.restoreRetired(old);
        throw linkError;
      }
      if (!twin) {
        await this.restoreRetired(old);
        throw error;
      }
      await this.indexEntry(retired);
      await this.startNoLaterThan(twin, at);
      return { entry: twin, created: false };
    }
    retired.supersededBy = created._id;
    await retired.save();
    await this.indexEntry(retired);
    await this.indexEntry(created);
    return { entry: created, created: true };
  }

  /** Undo a fold whose target turned out non-live: restore the source and clear the link this call wrote to that twin. */
  private async unfoldSource(old: IBrainEntryDocument, twinId: Types.ObjectId): Promise<void> {
    await BrainEntry.updateOne({ _id: old._id, live: false, supersededBy: twinId }, { $set: { live: true }, $unset: { invalidAt: 1, expiredAt: 1, supersededBy: 1 } });
    await this.indexEntry(old);
  }

  /** Undo a retirement whose replacement never materialised; a successor another caller linked meanwhile stays. */
  private async restoreRetired(old: IBrainEntryDocument): Promise<void> {
    await BrainEntry.updateOne({ _id: old._id, live: false, supersededBy: { $exists: false } }, { $set: { live: true }, $unset: { invalidAt: 1, expiredAt: 1 } });
  }

  /**
   * Every curated entry made from `roots`, transitively, crossing episodic versions on the way: a copy promoted from
   * an agent's correction of an import, or the live successor of a superseded copy, is as much a descendant of the
   * source as a copy promoted from the import itself.
   */
  private async curatedLineage(roots: string[]): Promise<IBrainEntryDocument[]> {
    return (await this.derived(roots, ['promote', 'supersede'])).filter((doc) => doc.tier === 'curated');
  }

  /**
   * The curated lineage of an import's versions follows a downgrade of the source to untrusted provenance: each copy
   * carries the new origin, loses the standing tag, and gains the review tag, so externally authored text never keeps
   * auto-loading through a copy or a copy's successor.
   */
  private async demoteDependents(versionSlugs: string[]): Promise<void> {
    for (const dependent of await this.curatedLineage(versionSlugs)) {
      await this.demoteCopy(dependent);
    }
  }

  /** Apply an untrusted downgrade to one curated copy: the new origin, no standing tag, the review tag. Idempotent. */
  private async demoteCopy(copy: IBrainEntryDocument): Promise<void> {
    const tags = withSystemTags(copy.tags.filter((tag) => tag !== this.deps.config.standingTag), NEEDS_REVIEW_TAG);
    const settled = copy.originClass === 'untrusted' && copy.tags.length === tags.length && copy.tags.every((tag, i) => tag === tags[i]);
    if (settled) {
      await this.ensureIndexed(copy);
      return;
    }
    copy.originClass = 'untrusted';
    copy.tags = tags;
    await copy.save();
    await this.indexEntry(copy);
  }

  /** Bring a re-imported entry's governed metadata in step with the import and say whether anything moved. */
  private refreshMetadata(doc: IBrainEntryDocument, actor: BrainActor, kind: BrainKind, clean: ReturnType<typeof validateInput>, source: IBrainSource): boolean {
    const sameTags = doc.tags.length === clean.tags.length && doc.tags.every((tag, i) => tag === clean.tags[i]);
    const sameSource = doc.source?.path === source.path && doc.source?.url === source.url
      && (doc.source?.capturedAt?.getTime() ?? null) === (source.capturedAt?.getTime() ?? null);
    if (doc.title === clean.title && sameTags && doc.kind === kind && doc.namespace === clean.namespace
      && doc.importance === clean.importance && doc.originClass === actor.originClass && doc.authorAgent === actor.agent && sameSource) {
      return false;
    }
    doc.title = clean.title;
    doc.tags = clean.tags;
    doc.kind = kind;
    doc.namespace = clean.namespace;
    doc.importance = clean.importance;
    doc.originClass = actor.originClass;
    doc.authorAgent = actor.agent;
    doc.source = { ...source };
    return true;
  }

  async note(actor: BrainActor, input: NoteInput, visibility: Visibility = {}): Promise<{ entry: BrainEntryView; created: boolean }> {
    const clean = validateInput(input);
    if (!isVisible(clean.namespace, visibility)) {
      throw outside(clean.namespace);
    }
    // A caller may not set the store's own tags; otherwise an agent's note could carry `standing` into a promoted copy.
    clean.tags = clean.tags.filter((tag) => tag !== this.deps.config.standingTag && tag !== NEEDS_REVIEW_TAG);
    rejectSecrets('agent name', actor.agent);
    const contentHash = computeContentHash(clean.body);
    let firstImport = false;
    let retiredImport: IBrainEntryDocument | null = null;
    if (input.source) {
      // Source metadata is stored and returned to every reader, so it passes the same gate as the body.
      rejectSecrets('source', [input.source.system, input.source.externalId, input.source.path ?? '', input.source.url ?? ''].join(' '));
      if ((RESERVED_LINEAGE_SYSTEMS as readonly string[]).includes(input.source.system)) {
        // These label the store's own lineage copies; a caller-supplied import must not forge one.
        throw new BrainInputError('source.system "promote" and "supersede" are reserved for lineage');
      }
      const versions = await this.importedVersions(input.source);
      firstImport = versions === null;
      // A retry after a re-import that failed part-way: a version Mongo already retired must not keep reading as
      // current in the index.
      for (const version of versions?.versions ?? []) {
        if (!version.live) {
          await this.ensureIndexed(version);
        }
      }
      retiredImport = versions && !versions.head ? versions.imported : null;
      // Demotion runs on every untrusted import, not only the first: a retry after a partial failure must still repair the copies.
      const demote = actor.originClass === 'untrusted';
      if (versions && !versions.head && demote) {
        // Every version was retired, so a fresh entry is created below; the copies promoted from those versions still follow the downgrade.
        await this.demoteDependents(versions.slugs);
      }
      if (versions?.head) {
        const { imported, head } = versions;
        if (head.tier === 'curated') {
          // Curated is written only by promote and the owner; an import that resolves to one is a forged identity.
          throw new BrainInputError('an import identity resolves to a curated entry; imports never write the curated tier');
        }
        if (imported.contentHash === contentHash || head.contentHash === contentHash) {
          if (head._id.equals(imported._id)) {
            // Same body, but a re-import may still move governed metadata (title, tags, kind, namespace, importance, origin, path).
            if (this.refreshMetadata(imported, actor, input.kind, clean, input.source)) {
              await imported.save();
              await this.indexEntry(imported);
            } else {
              await this.ensureIndexed(imported);
            }
          } else {
            // The source matches its last snapshot, or now says what the correction says, so the correction stays the
            // current version. An agent's correction carries an untrusted re-import's downgrade, as the import's own row
            // would (an agent's correction of untrusted text is untrusted), or a re-promotion would trust it again; an
            // owner's correction is the owner vouching for that text, and stays the owner's.
            if (demote && head.originClass === 'agent') {
              head.originClass = 'untrusted';
              await head.save();
              await this.indexEntry(head);
            } else {
              await this.ensureIndexed(head);
            }
            if (imported.contentHash === contentHash) {
              await this.recordCapture(imported, input.source);
            } else {
              // Record this snapshot as folded into the correction, so the next re-import compares against what the
              // source last said: a change back to the text first imported then replaces the correction.
              await this.recordFoldedImport(actor, input.source, clean, input, contentHash, head);
            }
          }
          if (demote) {
            await this.demoteDependents(versions.slugs);
          }
          return { entry: await this.viewOf(head, visibility), created: false };
        }
        // The source changed: the new content supersedes the current version, whoever wrote it, and carries the
        // import identity again, dated by its capture time when that is after the version it replaces.
        const capturedAfter = input.validFrom && input.validFrom.getTime() > head.validFrom.getTime() ? input.validFrom : undefined;
        const replaced = await this.replace(head, actor, { title: clean.title, body: clean.body, tags: clean.tags, kind: input.kind, namespace: clean.namespace, importance: clean.importance, source: input.source }, capturedAfter);
        if (!replaced.created) {
          // The new content already lived in another entry, which the old version was folded into: record this snapshot
          // as folded there too, so a re-import of it is recognized instead of sent again.
          await this.recordFoldedImport(actor, input.source, clean, input, contentHash, replaced.entry);
        }
        if (demote) {
          await this.demoteDependents(versions.slugs);
        }
        return { entry: toView(replaced.entry, null), created: replaced.created };
      }
    }
    // Deduplication is episodic and per namespace: a curated copy sharing the body is the owner's, and an agent's note
    // must never move it, or resolve to an entry in a namespace the caller cannot see.
    const twinQuery = { contentHash, namespace: clean.namespace, live: true, tier: 'episodic' as const, forgotten: { $exists: false } };
    const existing = await BrainEntry.findOne(twinQuery);
    if (existing) {
      if (firstImport && input.source) {
        await this.recordFoldedImport(actor, input.source, clean, input, contentHash, existing);
      } else if (retiredImport && input.source) {
        if (retiredImport.contentHash === contentHash && retiredImport.supersededBy?.equals(existing._id)) {
          // An unchanged re-import of a source whose import was folded into this entry.
          await this.recordCapture(retiredImport, input.source);
        } else {
          // Every version is retired and the source now folds into this entry, with new text or into a twin other than
          // the one its latest version names: record this snapshot as folded here.
          await this.recordFoldedImport(actor, input.source, clean, input, contentHash, existing);
        }
      }
      await this.startNoLaterThan(existing, input.validFrom ?? this.now());
      return { entry: await this.viewOf(existing, visibility), created: false };
    }
    let doc: IBrainEntryDocument;
    try {
      doc = await this.create({
        title: clean.title, body: clean.body, tags: clean.tags, kind: input.kind, tier: 'episodic',
        namespace: clean.namespace, originClass: actor.originClass, authorAgent: actor.agent, importance: clean.importance,
        validFrom: input.validFrom ?? this.now(), contentHash, ...(input.source ? { source: input.source } : {}),
      });
    } catch (error) {
      if (!isDuplicateKey(error, 'contentHash')) {
        throw error;
      }
      // Two identical notes raced: the unique hash index let one through, so answer with that one.
      const winner = await BrainEntry.findOne(twinQuery);
      if (!winner) {
        throw error;
      }
      if (firstImport && input.source) {
        await this.recordFoldedImport(actor, input.source, clean, input, contentHash, winner);
      }
      await this.startNoLaterThan(winner, input.validFrom ?? this.now());
      return { entry: await this.viewOf(winner, visibility), created: false };
    }
    await this.indexEntry(doc);
    return { entry: toView(doc, null), created: true };
  }

  /**
   * A re-import that writes nothing still records when its source was last captured, on the import's own latest
   * version even while that version is retired (an agent's correction or a body twin is current), so an importer
   * that compares capture times does not send the unchanged source again. Only a later time is recorded, and
   * `updatedAt` stays put: the version did not change, and its index row stays in step.
   */
  private async recordCapture(imported: IBrainEntryDocument, source: IBrainSource): Promise<void> {
    const at = source.capturedAt;
    if (!at || at.getTime() <= (imported.source?.capturedAt?.getTime() ?? Number.NEGATIVE_INFINITY)) {
      return;
    }
    await BrainEntry.updateOne({ _id: imported._id }, { $set: { 'source.capturedAt': at } }, { timestamps: false });
  }

  /**
   * A first import whose body already lives in another entry: the identity is recorded as a retired version folded
   * into that entry, so later re-imports, source-based forgets and provenance downgrades can find the import while
   * the body stays deduplicated.
   */
  private async recordFoldedImport(
    actor: BrainActor,
    source: IBrainSource,
    clean: ReturnType<typeof validateInput>,
    input: NoteInput,
    contentHash: string,
    twin: IBrainEntryDocument,
  ): Promise<void> {
    const at = input.validFrom ?? this.now();
    const alias = await this.create({
      title: clean.title, body: clean.body, tags: clean.tags, kind: input.kind, tier: 'episodic',
      namespace: clean.namespace, originClass: actor.originClass, authorAgent: actor.agent, importance: clean.importance,
      validFrom: at, invalidAt: at, expiredAt: at, live: false, supersededBy: twin._id, contentHash, source,
    });
    await this.indexEntry(alias);
  }

  /**
   * After an import item is written: forget the identities of that item it no longer has. An item too long for one
   * entry travels as parts `<id>#part-<k>` of `parts`; part k of n retires the whole-item identity and any part after
   * n, and a whole item (no `parts`) retires every part, so a file that shrinks, or crosses the size limit either way,
   * leaves no stale text current. Each is forgotten by its import identity, corrections of it included. Returns how
   * many entries were forgotten.
   */
  async retireObsoleteParts(actor: BrainActor, source: { system: string; externalId: string }, parts?: number): Promise<number> {
    const part = parts === undefined ? null : PART_SUFFIX.exec(source.externalId);
    if (parts !== undefined && (!part || Number(part[1]) < 1 || Number(part[1]) > parts)) {
      throw new BrainInputError('parts is set only on an item whose externalId ends in #part-<k>, with k from 1 to parts');
    }
    const base = part ? source.externalId.slice(0, part.index) : source.externalId;
    // Forgotten identities count too: a part's original forgotten by slug can still have a live correction, which
    // forget() reaches through it (and an identity with nothing left to forget adds nothing to the count).
    const family: string[] = await BrainEntry.distinct('source.externalId', {
      'source.system': source.system,
      'source.externalId': { $regex: `^${escapeRegex(base)}(?:#part-\\d+)?$` },
    });
    const obsolete = family.filter((externalId) => {
      // A part of this base carries the suffix right after it; the base itself may end in a lookalike.
      const member = PART_SUFFIX.exec(externalId);
      const memberPart = member !== null && member.index === base.length ? Number(member[1]) : null;
      if (part === null) {
        return memberPart !== null;
      }
      return memberPart === null ? externalId === base : memberPart > Number(parts);
    });
    let forgotten = 0;
    for (const externalId of obsolete) {
      forgotten += (await this.forget(actor, { source: { system: source.system, externalId } }, 'the import no longer has this part')).forgotten;
    }
    return forgotten;
  }

  async supersede(
    actor: BrainActor,
    slug: string,
    input: { body: string; reason: string; expectedHash: string; title?: string; tags?: string[] },
    visibility: Visibility = {},
  ): Promise<BrainEntryView> {
    rejectSecrets('agent name', actor.agent);
    const old = await this.live(slug, visibility);
    if (old.tier === 'curated' && actor.originClass !== 'owner') {
      throw new BrainInputError('Curated entries are changed only by the owner.');
    }
    if (old.contentHash !== input.expectedHash) {
      throw new BrainConflictError(old.contentHash);
    }
    const reason = input.reason.trim();
    if (reason.length === 0 || reason.length > 300) {
      throw new BrainInputError('reason must be 1-300 characters');
    }
    rejectSecrets('reason', reason);
    const clean = validateInput({ title: input.title ?? old.title, body: input.body, kind: old.kind, tags: input.tags ?? old.tags, namespace: old.namespace, importance: old.importance });
    // An agent's correction of untrusted text is still untrusted: its words came from outside, and only the owner vouches.
    const writer = actor.originClass === 'agent' && old.originClass === 'untrusted' ? { ...actor, originClass: 'untrusted' as const } : actor;
    const next = await this.replace(old, writer, { title: clean.title, body: clean.body, tags: clean.tags, kind: old.kind, namespace: old.namespace, importance: old.importance, source: { system: 'supersede', externalId: old.slug, path: reason } });
    return toView(next.entry, null);
  }

  /**
   * Soft-delete. `slug` selects one entry; `source` selects one imported item, every version written under that
   * identity (system AND externalId) plus the agent corrections derived from them; `wholeSource` retires everything an
   * import system wrote and is a distinct selector on purpose, so the agent tools, whose schema has no such field,
   * cannot reach it by leaving `externalId` out. The store's own lineage labels are not import systems: a source
   * selector naming `promote` or `supersede` is refused, or "forget every promote" would retire the curated tier. A
   * namespace-confined caller forgets by slug only: an import identity's versions may span namespaces.
   */
  async forget(
    actor: BrainActor,
    selector: { slug?: string; source?: { system: string; externalId: string }; wholeSource?: { system: string } },
    reason: string,
    visibility: Visibility = {},
  ): Promise<{ forgotten: number }> {
    const why = reason.trim().slice(0, 300);
    rejectSecrets('reason', why);
    rejectSecrets('agent name', actor.agent);
    const query: Record<string, unknown> = {};
    const given = [selector.slug, selector.source, selector.wholeSource].filter((part) => part !== undefined).length;
    if (given !== 1) {
      // Two selectors would let one pick the entry and the other widen it to that entry's corrections.
      throw new BrainInputError(given === 0 ? 'forget needs a slug or a source selector' : 'forget takes exactly one selector: slug, source, or a whole source');
    }
    const bySource = selector.source ?? selector.wholeSource;
    if (bySource && visibility.namespaces !== undefined) {
      throw new BrainInputError('A namespace-confined key forgets one entry at a time, by slug.');
    }
    if (bySource && (RESERVED_LINEAGE_SYSTEMS as readonly string[]).includes(bySource.system)) {
      throw new BrainInputError('source.system "promote" and "supersede" are reserved for lineage, not import sources');
    }
    if (selector.slug) {
      query.slug = selector.slug;
    } else if (selector.source) {
      query['source.system'] = selector.source.system;
      query['source.externalId'] = selector.source.externalId;
    } else if (selector.wholeSource) {
      query['source.system'] = selector.wholeSource.system;
    }
    const at = this.now();
    const matched: IBrainEntryDocument[] = (await BrainEntry.find(query)).filter((doc) => isVisible(doc.namespace, visibility));
    // An import's current version may be an agent's supersede, whose source is `supersede/<slug>` rather than the
    // identity: retire those too, and first, so a forget that fails part-way still leaves the identity's own rows for
    // the caller to retry by.
    const docs = bySource ? [...await this.derived(matched.map((doc) => doc.slug), ['supersede']), ...matched] : matched;
    const forgotten: IBrainEntryDocument[] = [];
    for (const doc of docs) {
      const entryId = doc._id.toString();
      if (doc.tier === 'curated' && actor.originClass !== 'owner') {
        // The same boundary as supersede: only the owner retires curated entries.
        if (selector.slug) {
          throw new BrainInputError('Curated entries are forgotten only by the owner.');
        }
        continue;
      }
      if (doc.forgotten) {
        // A retry: Mongo already holds the forget, so only a leftover index row can remain.
        if (this.deps.index.hasEntry(entryId)) {
          this.deps.index.removeEntry(entryId);
        }
        continue;
      }
      // Clear the index row before Mongo records the forget. Removal is idempotent, so a failure between the two
      // steps leaves a live but unsearchable entry that the next dedupe or reindex repairs, never a searchable ghost.
      this.deps.index.removeEntry(entryId);
      doc.forgotten = { at, reason: why, by: actor.agent };
      doc.live = false;
      await doc.save();
      // A reindex that swapped in while the save was in flight rebuilt this entry from Mongo: remove it again.
      this.deps.index.removeEntry(entryId);
      forgotten.push(doc);
    }
    // Curated entries built from a forgotten source, and their successors, are flagged for review, in Mongo and in the
    // index. The roots are every forgotten match, not only this call's, so a retry repairs a dependent whose tag or
    // index row failed to land the first time.
    const roots = docs.filter((doc) => doc.forgotten).map((doc) => doc.slug);
    if (roots.length > 0) {
      for (const dependent of await this.curatedLineage(roots)) {
        if (dependent.tags.includes(NEEDS_REVIEW_TAG)) {
          await this.ensureIndexed(dependent);
          continue;
        }
        dependent.tags = withSystemTags(dependent.tags, NEEDS_REVIEW_TAG);
        await dependent.save();
        await this.indexEntry(dependent);
      }
    }
    return { forgotten: forgotten.length };
  }

  async get(slug: string, offset = 0, visibility: Visibility = {}): Promise<BrainEntryRead | null> {
    const doc = await BrainEntry.findOne({ slug });
    if (!doc || doc.forgotten || !isVisible(doc.namespace, visibility)) {
      return null;
    }
    // Every version this one replaced, nearest first and, within a step, newest retirement first: a fold gives an entry
    // several predecessors, so each branch is followed, up to 10 versions in all.
    const history: BrainEntryRead['history'] = [];
    const seen = new Set([doc._id.toString()]);
    let frontier: Types.ObjectId[] = [doc._id];
    for (let visited = 0; frontier.length > 0 && visited < 10;) {
      const versions = await BrainEntry.find({ supersededBy: { $in: frontier } }).sort({ invalidAt: -1, _id: -1 }).limit(10 - visited);
      frontier = [];
      for (const version of versions) {
        if (seen.has(version._id.toString())) {
          continue;
        }
        seen.add(version._id.toString());
        visited += 1;
        // A forgotten (or, for a confined key, invisible) version is unreadable, so it is not listed; the walk still passes through it to older ones.
        if (!version.forgotten && isVisible(version.namespace, visibility)) {
          history.push({ slug: version.slug, invalidAt: version.invalidAt ? version.invalidAt.toISOString() : null });
        }
        frontier.push(version._id);
      }
    }
    const start = Math.max(0, Math.min(offset, doc.body.length));
    const body = doc.body.slice(start, start + READ_WINDOW_CHARS);
    return { ...(await this.viewOf(doc, visibility)), body, offset: start, hasMore: start + body.length < doc.body.length, history };
  }

  async list(filter: ListFilter, page: PageInput, visibility: Visibility = {}): Promise<PageResult<BrainEntryView>> {
    const query: Record<string, unknown> = { forgotten: { $exists: false } };
    const namespaces = filter.namespaces ?? visibility.namespaces;
    const allowed = namespaces?.filter((namespace) => isVisible(namespace, visibility));
    if (allowed) { query.namespace = { $in: allowed }; }
    if (filter.kind) { query.kind = filter.kind; }
    if (filter.tier) { query.tier = filter.tier; }
    if (filter.since) { query.updatedAt = { $gte: filter.since }; }
    if (filter.authorAgent) { query.authorAgent = filter.authorAgent; }
    if (filter.current) { query.live = true; }
    // Newest first by creation: superseding touches the old entry's updatedAt, and the live entry should lead.
    const docs = await BrainEntry.find(query).sort({ createdAt: -1, _id: -1 }).skip((page.page - 1) * page.limit).limit(page.limit + 1);
    const items = await Promise.all(docs.slice(0, page.limit).map((doc) => this.viewOf(doc, visibility)));
    return { items, page: page.page, limit: page.limit, hasMore: docs.length > page.limit };
  }

  /** Owner-only: copy an episodic entry into the curated tier. */
  async promote(slug: string, opts: { standing: boolean }): Promise<BrainEntryView> {
    const source = await this.live(slug);
    if (source.originClass === 'untrusted') {
      throw new BrainInputError('Untrusted entries stay searchable but are never promoted.');
    }
    const base = source.tags.filter((tag) => tag !== this.deps.config.standingTag && tag !== NEEDS_REVIEW_TAG);
    const tags = opts.standing ? withSystemTags(base, this.deps.config.standingTag) : withSystemTags(base);
    // A retry, or a re-promotion after the copy was superseded or demoted, finds the live curated descendant through
    // the lineage and brings it in step rather than starting a second curated branch: the owner's corrected successor
    // is kept, the source's (again trusted) provenance is restored, and the review tag, which the re-promotion
    // answers, is cleared. Look across every version of the lineage, not just source.slug: a copy promoted from an
    // earlier version (promote(E1), supersede E1 -> E2, promote(E2); or promote an import, re-import it changed, then
    // promote the new version) must be found, not duplicated. The loop re-resolves when a concurrent re-promotion
    // wins the retirement CAS or the insert, so two callers never both end with a live copy.
    const chain = await this.lineageVersions(source);
    for (let attempt = 0; attempt < 3; attempt++) {
      const lineage = await this.curatedLineage([...chain, source.slug]);
      const live = lineage.find((doc) => doc.live) ?? null;
      // Every attempt first repairs what a failed or raced re-promotion left behind, ahead of any early return.
      await this.repairRetiredCopies(lineage, live);
      if (live) {
        // The existing curated copy is brought in step when it holds the same body, or when it is an owner's
        // supersede-correction of a promoted copy (a deliberate edit a re-promotion must not overwrite).
        if (live.contentHash === source.contentHash || live.source?.system === 'supersede') {
          const wanted = withSystemTags(live.tags.filter((tag) => tag !== NEEDS_REVIEW_TAG), ...(opts.standing ? [this.deps.config.standingTag] : []));
          const inStep = live.originClass === source.originClass && live.tags.length === wanted.length && live.tags.every((tag, i) => tag === wanted[i]);
          if (inStep) {
            await this.ensureIndexed(live);
            return toView(live, null);
          }
          // Compare-and-set on `live`: an owner supersede of this copy landing meanwhile retires it, and saving this
          // snapshot would index the retired copy as current. On a miss, re-resolve to the successor.
          const updated = await BrainEntry.findOneAndUpdate({ _id: live._id, live: true }, { $set: { originClass: source.originClass, tags: wanted } }, { new: true });
          if (!updated) {
            continue;
          }
          return this.settleCopy(source, updated);
        }
        // Retire the stale copy first (compare-and-set on `live`); if another caller won it, re-resolve rather than create a duplicate.
        const at = this.now();
        const retiredCopy = await BrainEntry.findOneAndUpdate({ _id: live._id, live: true }, { $set: { live: false, invalidAt: at, expiredAt: at } }, { new: true });
        if (!retiredCopy) {
          continue;
        }
        let doc: IBrainEntryDocument;
        try {
          doc = await this.create({
            title: source.title, body: source.body, tags, kind: source.kind, tier: 'curated',
            namespace: source.namespace, originClass: source.originClass, authorAgent: 'owner', importance: source.importance,
            validFrom: source.validFrom, contentHash: source.contentHash, source: { system: 'promote', externalId: source.slug },
          });
        } catch (error) {
          // A concurrent promote may have inserted the replacement meanwhile: this insert then collides on the promote
          // identity, or fails for an unrelated reason after the other row landed. The copy retired here must then stay
          // retired (restoring it would leave two live copies); it is linked to that winner now, so the lineage is
          // consistent even when no attempt is left, and the next attempt returns the winner in step. With no winner,
          // a failure undoes the retirement so a transient error never leaves the lineage without a live copy.
          const winner = await BrainEntry.findOne({ live: true, tier: 'curated', 'source.system': 'promote', 'source.externalId': source.slug });
          if (winner) {
            await this.linkRetired(retiredCopy, winner);
            continue;
          }
          if (isDuplicateKey(error, 'source.externalId') || (error as { code?: number }).code === DUPLICATE_KEY) {
            continue; // the colliding row was retired or forgotten since; re-resolve
          }
          await this.restoreRetired(retiredCopy);
          throw error;
        }
        retiredCopy.supersededBy = doc._id;
        await retiredCopy.save();
        await this.indexEntry(retiredCopy);
        return this.settleCopy(source, doc);
      }
      // No live curated copy: create the first one. A concurrent winner would collide on the promote identity's unique index.
      try {
        const doc = await this.create({
          title: source.title, body: source.body, tags, kind: source.kind, tier: 'curated',
          namespace: source.namespace, originClass: source.originClass, authorAgent: 'owner', importance: source.importance,
          validFrom: source.validFrom, contentHash: source.contentHash, source: { system: 'promote', externalId: source.slug },
        });
        // A copy that a raced re-promotion retired before this attempt now has its successor.
        await this.repairRetiredCopies(lineage, doc);
        return this.settleCopy(source, doc);
      } catch (error) {
        if (isDuplicateKey(error, 'source.externalId') || (error as { code?: number }).code === DUPLICATE_KEY) {
          continue; // a concurrent promote created the copy; re-resolve and bring it in step
        }
        throw error;
      }
    }
    throw new BrainConflictError(source.contentHash);
  }

  /**
   * Retired curated copies of a lineage that a failed or raced re-promotion left inconsistent: a row older than its
   * document is re-indexed (so it carries its invalidAt and stops reading as current), and a retired promote copy
   * whose successor link was never saved is linked to the copy that replaced it, or to `successor` (the lineage's
   * live copy, or the copy just created) when no lineage copy postdates its retirement.
   */
  private async repairRetiredCopies(lineage: IBrainEntryDocument[], successor: IBrainEntryDocument | null): Promise<void> {
    for (const retired of lineage.filter((doc) => !doc.live)) {
      if (successor && !retired.supersededBy && retired.source?.system === 'promote') {
        if (await this.linkRetired(retired, this.replacementOf(retired, lineage) ?? successor)) {
          continue;
        }
      }
      await this.ensureIndexed(retired);
    }
  }

  /** The copy the re-promotion that retired `retired` created: the earliest lineage copy created at or after that retirement. */
  private replacementOf(retired: IBrainEntryDocument, lineage: IBrainEntryDocument[]): IBrainEntryDocument | null {
    const at = retired.invalidAt?.getTime();
    if (at === undefined) {
      return null;
    }
    return lineage
      .filter((doc) => !doc._id.equals(retired._id) && doc.createdAt.getTime() >= at)
      .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())[0] ?? null;
  }

  /**
   * Record `successor` as what replaced a retired copy, compare-and-set on the copy still being retired and unlinked:
   * a concurrent caller may have restored or linked it meanwhile, and this must never write onto that. Indexes the
   * linked copy (with its invalidAt) and says whether the link was written.
   */
  private async linkRetired(retired: IBrainEntryDocument, successor: IBrainEntryDocument): Promise<boolean> {
    const linked = await BrainEntry.findOneAndUpdate(
      { _id: retired._id, live: false, supersededBy: { $exists: false } },
      { $set: { supersededBy: successor._id } },
      { new: true },
    );
    if (!linked) {
      return false;
    }
    await this.indexEntry(linked);
    return true;
  }

  /**
   * The other versions of the lineage `doc` belongs to: its predecessors up the whole supersede chain (cycle-safe)
   * and, when that chain starts at an import, every version written under the import identity plus the corrections
   * made from them. A re-import carries the identity rather than `supersede/<slug>`, so the chain alone misses it.
   */
  private async lineageVersions(doc: IBrainEntryDocument): Promise<string[]> {
    const slugs: string[] = [];
    const seen = new Set([doc.slug]);
    let cursor: IBrainEntryDocument | null = doc;
    while (cursor?.source?.system === 'supersede') {
      const pred: string = cursor.source.externalId;
      if (seen.has(pred)) {
        break;
      }
      seen.add(pred);
      slugs.push(pred);
      cursor = await BrainEntry.findOne({ slug: pred });
    }
    const identity = cursor?.source && !(RESERVED_LINEAGE_SYSTEMS as readonly string[]).includes(cursor.source.system) ? cursor.source : null;
    const imported = identity ? (await this.importedVersions(identity))?.slugs ?? [] : [];
    return [...new Set([...slugs, ...imported])].filter((slug) => slug !== doc.slug);
  }

  /**
   * After a curated copy is written or restored: an untrusted re-import that raced the promotion may have downgraded
   * the source after it was read (and scanned for copies before this one carried its provenance), so the source is
   * re-read and the copy demoted if so.
   */
  private async settleCopy(source: IBrainEntryDocument, copy: IBrainEntryDocument): Promise<BrainEntryView> {
    if (source.source) {
      // A same-source untrusted re-import that raced this promotion retires the old row and either creates an
      // untrusted successor or folds the lineage into an unrelated twin, so check the live lineage head, not the
      // original row. A missing head means the import's versions were all retired meanwhile: the copy cannot be
      // confirmed trusted, so it is demoted rather than left standing on the retired source's stale provenance.
      const head = (await this.importedVersions(source.source))?.head ?? null;
      if (!head || head.originClass === 'untrusted') {
        await this.demoteCopy(copy);
      } else {
        await this.indexEntry(copy);
      }
      return toView(copy, null);
    }
    // A source-less note has no import identity to downgrade; an ordinary supersede is a content revision, not a
    // provenance change, so the copy keeps its tier (re-read only to catch a concurrent owner downgrade of the row).
    const current = await BrainEntry.findById(source._id).select('originClass').lean();
    if (current?.originClass === 'untrusted') {
      await this.demoteCopy(copy);
    } else {
      await this.indexEntry(copy);
    }
    return toView(copy, null);
  }

  /** Index every non-forgotten entry, as a rebuild of the whole file does. */
  async reindexAll(onProgress?: (done: number) => void): Promise<{ entries: number; chunks: number }> {
    let entries = 0;
    let chunks = 0;
    for await (const doc of BrainEntry.find({ forgotten: { $exists: false } }).cursor()) {
      chunks += await indexDocument(this.indexDeps(), doc);
      entries += 1;
      onProgress?.(entries);
    }
    return { entries, chunks };
  }
}
