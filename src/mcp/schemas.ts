import { z } from 'zod';

import { BRAIN_KINDS, BRAIN_TIERS, MAX_BODY_CHARS, MAX_TITLE_CHARS, MAX_USER_TAGS, NAMESPACE_PATTERN } from '../brain/model.js';

const namespace = z.string().regex(NAMESPACE_PATTERN, 'shared, repo:<slug>, or agent:<name>').optional();
const tier = z.enum(BRAIN_TIERS).optional();
const slug = z.string().trim().min(1).max(80);
const title = z.string().trim().min(1).max(MAX_TITLE_CHARS);
const body = z.string().min(1).max(MAX_BODY_CHARS);
const tags = z.array(z.string().trim().min(1).max(50)).max(MAX_USER_TAGS);
const isoDate = z.iso.datetime({ offset: true });

/** Raw zod shapes: the MCP SDK takes these as `inputSchema`, REST wraps them in `z.object(...).strict()`. */
export const brainSearchShape = {
  query: z.string().trim().min(1).max(300).describe('What to look for, in natural language or exact identifiers.'),
  namespace: namespace.describe('Restrict to one namespace.'),
  kinds: z.array(z.enum(BRAIN_KINDS)).min(1).max(BRAIN_KINDS.length).optional().describe('Kinds to include. Default: memory, decision, handoff, doc, reference.'),
  tier: tier.describe('episodic, curated, or review.'),
  validAt: isoDate.optional().describe('Return what was true at this instant (ISO 8601).'),
  topK: z.number().int().min(1).max(10).optional().describe('Results to return, 1-10. Default 6.'),
};

export const brainGetShape = {
  slug: slug.describe('Entry slug from a search or list result.'),
  offset: z.number().int().min(0).max(1_000_000).optional().describe('Character offset for long bodies.'),
};

export const brainListShape = {
  namespace,
  kind: z.enum(BRAIN_KINDS).optional(),
  tier,
  since: isoDate.optional().describe('Only entries updated at or after this instant.'),
  current: z.boolean().optional().describe('Only current versions: leave superseded ones out.'),
  page: z.number().int().min(1).max(200).optional(),
  limit: z.number().int().min(1).max(50).optional(),
};

export const brainContextShape = {
  namespace: namespace.describe('Include this namespace\'s standing facts beside the shared ones.'),
};

export const brainNoteShape = {
  title,
  body: body.describe('Markdown. Verbatim is better than summarised.'),
  kind: z.enum(BRAIN_KINDS),
  tags: tags.optional(),
  namespace: namespace.describe('shared, repo:<slug>, or agent:<name>. Default: shared, or a confined key\'s first namespace.'),
  importance: z.number().int().min(1).max(10).optional().describe('1-10, default 5.'),
  validFrom: isoDate.optional().describe('When the fact became true, if not now.'),
};

export const brainSupersedeShape = {
  slug,
  body,
  reason: z.string().trim().min(1).max(300),
  expectedHash: z.string().length(64).describe('The entry\'s current contentHash.'),
  title: title.optional(),
  tags: tags.optional(),
};

const sourceSystem = z.string().min(1).max(64).describe('The import system, e.g. claude-memory.');
const forgetReason = z.string().trim().min(1).max(300);

/**
 * The agent form of forget selects one entry by slug, or one imported item by its import identity (system AND
 * externalId: every version imported under it plus any agent correction of it). A system-only selector would retire a
 * whole import source in one call, so it is not expressible here; that form exists only on the owner's REST route
 * (`brainForgetSourceSchema`).
 */
export const brainForgetShape = {
  slug: slug.optional().describe('Forget this one entry.'),
  source: z.object({ system: sourceSystem, externalId: z.string().min(1).max(512).describe('The item id within that system.') }).optional()
    .describe('Forget what was imported under this exact identity: every version of that item and any agent correction of it.'),
  reason: forgetReason,
};

/** Owner only: retire every entry an import system wrote. */
export const brainForgetSourceSchema = z.object({
  source: z.object({ system: sourceSystem }).strict(),
  reason: forgetReason,
}).strict();
export type BrainForgetSourceArgs = z.infer<typeof brainForgetSourceSchema>;

export const MAX_IMPORT_ITEMS = 100;
/** The import system label an importer sends: a slug, never one of the store's own lineage labels. */
export const IMPORT_SOURCE_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/u;

/**
 * One item of the owner's bulk import. The route validates every item before it writes any, so one bad item fails the
 * whole request; the importers check each item against this same schema first and drop only that one.
 */
export const brainImportItemSchema = z.object({
  externalId: z.string().min(1).max(512),
  title,
  body,
  kind: z.enum(BRAIN_KINDS),
  tags: tags.optional(),
  namespace,
  importance: z.number().int().min(1).max(10).optional(),
  capturedAt: isoDate.optional(),
  path: z.string().max(1024).optional(),
  /** On each part of an item split for size: how many parts the item has. */
  parts: z.number().int().min(2).max(10_000).optional(),
}).refine((item) => {
  if (item.parts === undefined) {
    return true;
  }
  const part = /#part-(\d+)$/u.exec(item.externalId);
  return part !== null && Number(part[1]) >= 1 && Number(part[1]) <= item.parts;
}, { message: 'parts belongs on an item whose externalId ends in #part-<k>, with k from 1 to parts', path: ['parts'] });

/** Owner only: a bulk import that sets the origin class for every item it carries. */
export const brainImportSchema = z.object({
  originClass: z.enum(['owner', 'agent', 'untrusted']),
  items: z.array(brainImportItemSchema).min(1).max(MAX_IMPORT_ITEMS),
}).strict();

export const brainPromoteSchema = z.object({ slug, standing: z.boolean().optional() }).strict();

export const brainSearchSchema = z.object(brainSearchShape).strict();
export const brainGetSchema = z.object(brainGetShape).strict();
export const brainListSchema = z.object(brainListShape).strict();
export const brainContextSchema = z.object(brainContextShape).strict();
export const brainNoteSchema = z.object(brainNoteShape).strict();
export const brainSupersedeSchema = z.object(brainSupersedeShape).strict();
export const brainForgetSchema = z.object(brainForgetShape).strict();

export type BrainSearchArgs = z.infer<typeof brainSearchSchema>;
export type BrainGetArgs = z.infer<typeof brainGetSchema>;
export type BrainListArgs = z.infer<typeof brainListSchema>;
export type BrainContextArgs = z.infer<typeof brainContextSchema>;
export type BrainNoteArgs = z.infer<typeof brainNoteSchema>;
export type BrainSupersedeArgs = z.infer<typeof brainSupersedeSchema>;
export type BrainForgetArgs = z.infer<typeof brainForgetSchema>;
