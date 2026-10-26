import type { KeyRole } from '../auth/keys.js';
import type { BrainConfig } from '../brain/config.js';
import { type BrainContextBlock, buildContext, contextNamespaces } from '../brain/context.js';
import { type SearchDeps, type SearchHit, searchBrain } from '../brain/search.js';
import {
  type BrainActor, BrainConflictError, type BrainEntryRead, type BrainEntryView, BrainInputError, BrainNotFoundError, type BrainStore, type Visibility,
} from '../brain/store.js';
import { type Logger, reasonOf, silentLogger } from '../log.js';
import type { BrainContextArgs, BrainForgetArgs, BrainGetArgs, BrainListArgs, BrainNoteArgs, BrainSearchArgs, BrainSupersedeArgs } from './schemas.js';

/** The authenticated caller: the key's name (attribution), role, and namespaces when the key is confined. */
export interface ToolCtx { agent: string; role: KeyRole; namespaces?: readonly string[] }
export interface ToolDeps { store: BrainStore; search: SearchDeps; config: BrainConfig; logger?: Logger }

export type ToolErrorCode = 'not_found' | 'conflict' | 'bad_input' | 'unavailable';
export type ToolResult<T> = { ok: true; data: T } | { ok: false; error: string; code: ToolErrorCode; currentHash?: string };

/**
 * The only place origin is set for a key's writes: an owner key writes as the owner, every other key as an agent.
 * The MCP endpoint never accepts owner keys, so every MCP write is an agent's.
 */
export const actorOf = (ctx: ToolCtx): BrainActor => ({ agent: ctx.agent, originClass: ctx.role === 'owner' ? 'owner' : 'agent' });
export const visibilityOf = (ctx: ToolCtx): Visibility => (ctx.namespaces ? { namespaces: ctx.namespaces } : {});

/** The namespaces a read is limited to: the one asked for (when the key may see it), else everything the key may see. */
function namespacesFor(ctx: ToolCtx, requested: string | undefined): readonly string[] | undefined {
  if (requested !== undefined) {
    if (ctx.namespaces && !ctx.namespaces.includes(requested)) {
      throw new BrainInputError(`namespace ${requested} is outside this key's namespaces`);
    }
    return [requested];
  }
  return ctx.namespaces;
}

export async function guard<T>(tool: string, work: () => Promise<T>, logger: Logger = silentLogger): Promise<ToolResult<T>> {
  try {
    return { ok: true, data: await work() };
  } catch (error) {
    if (error instanceof BrainNotFoundError) {
      return { ok: false, code: 'not_found', error: 'No entry with that slug is visible to this key.' };
    }
    if (error instanceof BrainConflictError) {
      return { ok: false, code: 'conflict', currentHash: error.currentHash, error: `The entry changed since you read it. Current contentHash: ${error.currentHash}. Re-read it, then retry.` };
    }
    if (error instanceof BrainInputError) {
      return { ok: false, code: 'bad_input', error: error.message };
    }
    // Internal detail stays in the local log; the model gets a stable sentence.
    logger.error('brain tool failed', { tool, reason: reasonOf(error) });
    return { ok: false, code: 'unavailable', error: 'The brain is temporarily unavailable.' };
  }
}

export const brainSearch = (deps: ToolDeps) => (ctx: ToolCtx, args: BrainSearchArgs): Promise<ToolResult<{ hits: SearchHit[] }>> =>
  guard('brain_search', async () => ({
    hits: await searchBrain(deps.search, ctx.agent, {
      query: args.query,
      namespaces: namespacesFor(ctx, args.namespace),
      kinds: args.kinds,
      tier: args.tier,
      validAt: args.validAt ? new Date(args.validAt) : undefined,
      topK: args.topK,
    }),
  }), deps.logger);

export const brainGet = (deps: ToolDeps) => (ctx: ToolCtx, args: BrainGetArgs): Promise<ToolResult<BrainEntryRead>> =>
  guard('brain_get', async () => {
    const entry = await deps.store.get(args.slug, args.offset ?? 0, visibilityOf(ctx));
    if (!entry) {
      throw new BrainNotFoundError('not found');
    }
    return entry;
  }, deps.logger);

export const brainList = (deps: ToolDeps) => (ctx: ToolCtx, args: BrainListArgs): Promise<ToolResult<{ items: BrainEntryView[]; page: number; limit: number; hasMore: boolean }>> =>
  guard('brain_list', async () => deps.store.list({
    namespaces: namespacesFor(ctx, args.namespace),
    kind: args.kind,
    tier: args.tier,
    since: args.since ? new Date(args.since) : undefined,
    current: args.current,
  }, { page: args.page ?? 1, limit: args.limit ?? 20 }, visibilityOf(ctx)), deps.logger);

export const brainContext = (deps: ToolDeps) => (ctx: ToolCtx, args: BrainContextArgs): Promise<ToolResult<BrainContextBlock>> =>
  guard('brain_context', async () => buildContext(contextNamespaces(args.namespace, visibilityOf(ctx)), deps.config), deps.logger);

export const brainNote = (deps: ToolDeps) => (ctx: ToolCtx, args: BrainNoteArgs): Promise<ToolResult<{ entry: BrainEntryView; created: boolean }>> =>
  guard('brain_note', () => deps.store.note(actorOf(ctx), {
    title: args.title,
    body: args.body,
    kind: args.kind,
    tags: args.tags,
    // A confined key writes into its first namespace unless it names another of its own.
    namespace: args.namespace ?? ctx.namespaces?.[0] ?? 'shared',
    importance: args.importance,
    validFrom: args.validFrom ? new Date(args.validFrom) : undefined,
  }, visibilityOf(ctx)), deps.logger);

export const brainSupersede = (deps: ToolDeps) => (ctx: ToolCtx, args: BrainSupersedeArgs): Promise<ToolResult<BrainEntryView>> =>
  guard('brain_supersede', () => deps.store.supersede(actorOf(ctx), args.slug, {
    body: args.body,
    reason: args.reason,
    expectedHash: args.expectedHash,
    title: args.title,
    tags: args.tags,
  }, visibilityOf(ctx)), deps.logger);

export const brainForget = (deps: ToolDeps) => (ctx: ToolCtx, args: BrainForgetArgs): Promise<ToolResult<{ forgotten: number }>> =>
  guard('brain_forget', () => deps.store.forget(actorOf(ctx), { slug: args.slug, source: args.source }, args.reason, visibilityOf(ctx)), deps.logger);
