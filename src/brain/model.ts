import type { Document, Model, Types } from 'mongoose';
import mongoose, { Schema } from 'mongoose';

export const BRAIN_KINDS = ['memory', 'decision', 'handoff', 'doc', 'reference', 'message', 'mail', 'photo', 'chat'] as const;
export const BRAIN_TIERS = ['episodic', 'curated', 'review'] as const;
/** Source systems the store writes itself to label lineage copies; never an import source, so callers may not name them. */
export const RESERVED_LINEAGE_SYSTEMS = ['promote', 'supersede'] as const;
export const BRAIN_ORIGIN_CLASSES = ['owner', 'agent', 'untrusted', 'system'] as const;
export type BrainKind = (typeof BRAIN_KINDS)[number];
export type BrainTier = (typeof BRAIN_TIERS)[number];
export type BrainOriginClass = (typeof BRAIN_ORIGIN_CLASSES)[number];

/** `shared`, `repo:<slug>`, or `agent:<name>`. Lowercase only. */
export const NAMESPACE_PATTERN = /^(shared|repo:[a-z0-9][a-z0-9-]{0,63}|agent:[a-z0-9][a-z0-9@.-]{0,63})$/u;
export const isValidNamespace = (value: string): boolean => NAMESPACE_PATTERN.test(value);
export const MAX_TITLE_CHARS = 200;
export const MAX_BODY_CHARS = 100_000;
export const MAX_TAGS = 20;
/** Callers may set this many tags; the store keeps two slots for its own tags (standing, needs-review). */
export const MAX_USER_TAGS = MAX_TAGS - 2;
export const MAX_AUTHOR_AGENT_CHARS = 120;

export interface IBrainSource {
  system: string;
  externalId: string;
  path?: string;
  url?: string;
  capturedAt?: Date;
}

export interface IBrainForgotten {
  at: Date;
  reason: string;
  by: string;
}

export interface IBrainEntry {
  slug: string;
  title: string;
  body: string;
  tags: string[];
  kind: BrainKind;
  tier: BrainTier;
  namespace: string;
  originClass: BrainOriginClass;
  authorAgent: string;
  importance: number;
  validFrom: Date;
  invalidAt?: Date;
  expiredAt?: Date;
  supersededBy?: Types.ObjectId;
  contentHash: string;
  /** True until superseded or forgotten; the import-source identity is unique among live entries. */
  live: boolean;
  source?: IBrainSource;
  forgotten?: IBrainForgotten;
  createdAt: Date;
  updatedAt: Date;
}

export interface IBrainEntryDocument extends IBrainEntry, Document<Types.ObjectId> {}
export type BrainEntryModel = Model<IBrainEntryDocument>;

const sourceSchema = new Schema<IBrainSource>({
  system: { type: String, required: true, maxlength: 64 },
  externalId: { type: String, required: true, maxlength: 512 },
  path: { type: String, maxlength: 1024 },
  url: { type: String, maxlength: 2048 },
  capturedAt: { type: Date },
}, { _id: false });

const forgottenSchema = new Schema<IBrainForgotten>({
  at: { type: Date, required: true },
  reason: { type: String, required: true, maxlength: 300 },
  by: { type: String, required: true, maxlength: 120 },
}, { _id: false });

const brainEntrySchema = new Schema<IBrainEntryDocument>(
  {
    slug: { type: String, required: true, trim: true, maxlength: 80 },
    title: { type: String, required: [true, 'Title is required'], trim: true, maxlength: [MAX_TITLE_CHARS, 'Title cannot exceed 200 characters'] },
    body: { type: String, required: [true, 'Body is required'], maxlength: [MAX_BODY_CHARS, 'Body cannot exceed 100,000 characters'] },
    tags: { type: [String], default: [], validate: [(value: string[]) => value.length <= MAX_TAGS, `At most ${MAX_TAGS} tags`] },
    kind: { type: String, required: true, enum: BRAIN_KINDS },
    tier: { type: String, required: true, enum: BRAIN_TIERS },
    namespace: { type: String, required: true, validate: [isValidNamespace, 'Invalid namespace'] },
    originClass: { type: String, required: true, enum: BRAIN_ORIGIN_CLASSES },
    authorAgent: { type: String, required: true, trim: true, maxlength: MAX_AUTHOR_AGENT_CHARS },
    importance: { type: Number, required: true, min: 1, max: 10, default: 5 },
    validFrom: { type: Date, required: true },
    invalidAt: { type: Date },
    expiredAt: { type: Date },
    supersededBy: { type: Schema.Types.ObjectId, ref: 'BrainEntry' },
    contentHash: { type: String, required: true, maxlength: 128 },
    live: { type: Boolean, required: true, default: true, index: true },
    source: { type: sourceSchema, required: false },
    forgotten: { type: forgottenSchema, required: false },
  },
  {
    timestamps: true,
    toJSON: {
      transform(_doc, ret) {
        const result = ret as Record<string, unknown>;
        result.id = result._id;
        delete result._id;
        delete result.__v;
        return result;
      },
    },
  },
);

brainEntrySchema.index({ slug: 1 }, { unique: true });
// Current entries newest first.
brainEntrySchema.index({ live: 1, createdAt: -1, _id: -1 });
// brain_list without `current` lists every version newest first. Without an index in that order Mongo sorts whole
// documents in memory, and a server with a 32 MB blocking-sort cap and no disk spill fails every page past ~1,000 entries.
brainEntrySchema.index({ createdAt: -1, _id: -1 });
// The same order inside one or a few namespaces, for namespace-confined keys.
brainEntrySchema.index({ namespace: 1, createdAt: -1, _id: -1 });
brainEntrySchema.index({ tier: 1, updatedAt: -1 });
brainEntrySchema.index({ namespace: 1, kind: 1 });
/**
 * Identical live episodic bodies collapse to one entry per namespace; a promoted (curated) copy shares the hash on
 * purpose. Per namespace, so a note never resolves to (and reveals) an entry in a namespace its key cannot see.
 */
brainEntrySchema.index(
  { namespace: 1, contentHash: 1 },
  { unique: true, partialFilterExpression: { live: true, tier: 'episodic' } },
);
brainEntrySchema.index({ tier: 1, tags: 1, importance: -1 });
brainEntrySchema.index({ supersededBy: 1 });
brainEntrySchema.index(
  { 'source.system': 1, 'source.externalId': 1 },
  { unique: true, partialFilterExpression: { live: true, 'source.externalId': { $exists: true } } },
);

export const BrainEntry: BrainEntryModel = (mongoose.models.BrainEntry as BrainEntryModel | undefined)
  ?? mongoose.model<IBrainEntryDocument, BrainEntryModel>('BrainEntry', brainEntrySchema);
