import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import express, { type NextFunction, type Request, type RequestHandler, type Response } from 'express';
import type { z } from 'zod';

import type { KeyRecord, KeyRole, KeyStore } from '../auth/keys.js';
import { type BrainWriteQuota, withAgentWriteQuota } from '../brain/quota.js';
import { type ReindexOptions, getReindexStatus, startReindex } from '../brain/reindex.js';
import type { BrainRuntime } from '../brain/runtime.js';
import { RESERVED_LINEAGE_SYSTEMS } from '../brain/model.js';
import { importerAgent } from '../brain/store-views.js';
import { type Logger, reasonOf } from '../log.js';
import {
  type ToolCtx, type ToolDeps, type ToolResult, brainContext, brainForget, brainGet, brainList, brainNote, brainSearch, brainSupersede, guard,
} from '../mcp/handlers.js';
import {
  IMPORT_SOURCE_PATTERN, brainContextSchema, brainForgetSchema, brainForgetSourceSchema, brainGetSchema, brainImportSchema, brainListSchema,
  brainNoteSchema, brainPromoteSchema, brainSearchSchema, brainSupersedeSchema,
} from '../mcp/schemas.js';
import { createBrainMcpServer } from '../mcp/server.js';
import { BRAIN_WRITE_TOOLS } from '../mcp/tools.js';
import { VERSION } from '../version.js';
import { RateLimiter } from './rate-limit.js';

/** A 100,000-character note in any script, plus its JSON-RPC envelope. */
export const BODY_LIMIT_BYTES = 1024 * 1024;
/** One bulk import request: up to 100 items of up to 100,000 characters. */
export const IMPORT_BODY_LIMIT_BYTES = 10 * 1024 * 1024;

export interface AppDeps {
  runtime: BrainRuntime;
  keys: KeyStore;
  logger: Logger;
  rateLimitPerMinute: number;
  writeRateLimitPerMinute: number;
  agentQuota?: BrainWriteQuota | null;
  /** Tests inject a failing index opener into the reindex. */
  reindex?: Pick<ReindexOptions, 'openIndex'>;
}

const STATUS: Record<Exclude<ToolResult<never>, { ok: true }>['code'], number> = { not_found: 404, conflict: 409, bad_input: 400, unavailable: 503 };
const WRITE_TOOLS = new Set<string>(BRAIN_WRITE_TOOLS);

const keyOf = (res: Response): KeyRecord => res.locals.key as KeyRecord;
const ctxOf = (key: KeyRecord): ToolCtx => ({ agent: key.name, role: key.role, ...(key.namespaces ? { namespaces: key.namespaces } : {}) });

function send<T>(res: Response, result: ToolResult<T>): void {
  if (result.ok) {
    res.json({ ok: true, data: result.data });
    return;
  }
  res.status(STATUS[result.code]).json({ ok: false, error: result.error, code: result.code, ...(result.currentHash ? { currentHash: result.currentHash } : {}) });
}

/** Parse a query or body against a strict schema; 400 with the first issue on failure. */
function parse<S extends z.ZodType>(schema: S, input: unknown, res: Response): z.infer<S> | null {
  const parsed = schema.safeParse(input);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    res.status(400).json({ ok: false, code: 'bad_input', error: issue ? `${issue.path.join('.') || 'input'}: ${issue.message}` : 'Invalid input' });
    return null;
  }
  return parsed.data;
}

/** Query strings carry text; the read schemas want numbers, booleans and lists where they say so. */
function queryOf(req: Request): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(req.query)) {
    if (typeof value !== 'string') { continue; }
    if (key === 'kinds') { out[key] = value.split(','); continue; }
    if (['topK', 'offset', 'page', 'limit'].includes(key)) { out[key] = Number(value); continue; }
    if (key === 'current') { out[key] = value === 'true' || value === '1'; continue; }
    out[key] = value;
  }
  return out;
}

/** One JSON-RPC message, or a batch: the SDK transport dispatches arrays. */
const messagesOf = (body: unknown): unknown[] => (Array.isArray(body) ? body : [body]);
const isWriteCall = (message: unknown): boolean => {
  const call = message as { method?: unknown; params?: { name?: unknown } } | null;
  return call?.method === 'tools/call' && WRITE_TOOLS.has(String(call.params?.name));
};

export function createApp(deps: AppDeps): express.Express {
  const { runtime, keys, logger } = deps;
  const requests = new RateLimiter(deps.rateLimitPerMinute);
  const writes = new RateLimiter(deps.writeRateLimitPerMinute);
  const app = express();
  app.disable('x-powered-by');
  app.use((_req, res, next) => {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    next();
  });

  /** Bearer-key authentication for the given roles. A missing or unknown key is a 401; the wrong role a 403. */
  const authenticate = (roles: readonly KeyRole[]): RequestHandler => (req, res, next) => {
    const match = /^Bearer[ \t]+(\S+)[ \t]*$/iu.exec(req.get('authorization') ?? '');
    const found = match ? keys.lookup(match[1]) : null;
    if (!found || !found.ok) {
      const reason = found ? found.reason : 'missing';
      logger.warn('key rejected', { path: req.path, reason });
      res.setHeader('WWW-Authenticate', `Bearer realm="badland-brain"${found ? ', error="invalid_token"' : ''}`);
      res.status(401).json({ ok: false, code: 'unauthorized', error: reason === 'expired' ? 'This key has expired.' : 'A valid bearer key is required.' });
      return;
    }
    if (!roles.includes(found.key.role)) {
      logger.warn('key refused on route', { path: req.path, key: found.key.id, role: found.key.role });
      res.setHeader('WWW-Authenticate', 'Bearer realm="badland-brain", error="insufficient_scope"');
      res.status(403).json({ ok: false, code: 'forbidden', error: `A ${found.key.role} key cannot use this route.` });
      return;
    }
    res.locals.key = found.key;
    next();
  };

  /** Spend `cost(req)` units of a limiter for the key; 429 with Retry-After when the minute is used up. */
  const meter = (limiter: RateLimiter, cost: (req: Request) => number): RequestHandler => (req, res, next) => {
    const units = cost(req);
    if (units === 0) {
      next();
      return;
    }
    const taken = limiter.take(keyOf(res).id, units);
    if (!taken.ok) {
      res.setHeader('Retry-After', String(taken.retryAfterSeconds));
      res.status(429).json({ ok: false, code: 'rate_limited', error: 'Too many requests for this key; slow down.' });
      return;
    }
    next();
  };

  const toolDeps = (): ToolDeps => {
    const store = deps.agentQuota ? withAgentWriteQuota(runtime.store, deps.agentQuota) : runtime.store;
    return { store, search: runtime, config: runtime.config, logger };
  };

  const json = express.json({ limit: BODY_LIMIT_BYTES });
  const readers = authenticate(['read', 'agent', 'owner']);
  const writers = authenticate(['agent', 'owner']);
  const owner = authenticate(['owner']);
  const perRequest = meter(requests, () => 1);
  const perWrite = meter(writes, () => 1);

  app.get('/healthz', (_req, res) => {
    res.json({ ok: true, version: VERSION, stale: runtime.stale, ...runtime.index.counts(), model: runtime.embedder.model, dims: runtime.embedder.dims });
  });

  // ---------------------------------------------------------------- MCP: streamable HTTP, stateless, JSON replies
  app.post('/mcp', authenticate(['read', 'agent']), json,
    meter(requests, (req) => Math.max(1, messagesOf(req.body).length)),
    meter(writes, (req) => messagesOf(req.body).filter(isWriteCall).length),
    async (req: Request, res: Response) => {
      const key = keyOf(res);
      const server = createBrainMcpServer({ deps: toolDeps(), ctx: ctxOf(key) });
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
      res.on('close', () => {
        void transport.close();
        void server.close();
      });
      try {
        await server.connect(transport);
        await transport.handleRequest(req, res, req.body);
      } catch (error) {
        logger.error('MCP request failed', { key: key.id, reason: reasonOf(error) });
        if (!res.headersSent) {
          res.status(500).json({ jsonrpc: '2.0', id: null, error: { code: -32603, message: 'Internal error' } });
        }
      }
    });
  app.all('/mcp', (_req, res) => {
    res.setHeader('Allow', 'POST');
    res.status(405).json({ ok: false, code: 'method_not_allowed', error: 'POST JSON-RPC to /mcp.' });
  });

  // ---------------------------------------------------------------- REST twins of the tools
  app.get('/api/search', readers, perRequest, async (req, res) => {
    const args = parse(brainSearchSchema, queryOf(req), res);
    if (args) { send(res, await brainSearch(toolDeps())(ctxOf(keyOf(res)), args)); }
  });
  app.get('/api/entries', readers, perRequest, async (req, res) => {
    const args = parse(brainListSchema, queryOf(req), res);
    if (args) { send(res, await brainList(toolDeps())(ctxOf(keyOf(res)), args)); }
  });
  app.get('/api/entries/:slug', readers, perRequest, async (req, res) => {
    const args = parse(brainGetSchema, { ...queryOf(req), slug: req.params.slug }, res);
    if (args) { send(res, await brainGet(toolDeps())(ctxOf(keyOf(res)), args)); }
  });
  app.get('/api/context', readers, perRequest, async (req, res) => {
    const args = parse(brainContextSchema, queryOf(req), res);
    if (args) { send(res, await brainContext(toolDeps())(ctxOf(keyOf(res)), args)); }
  });
  app.post('/api/note', writers, perRequest, perWrite, json, async (req, res) => {
    const args = parse(brainNoteSchema, req.body, res);
    if (args) { send(res, await brainNote(toolDeps())(ctxOf(keyOf(res)), args)); }
  });
  app.post('/api/supersede', writers, perRequest, perWrite, json, async (req, res) => {
    const args = parse(brainSupersedeSchema, req.body, res);
    if (args) { send(res, await brainSupersede(toolDeps())(ctxOf(keyOf(res)), args)); }
  });
  app.post('/api/forget', writers, perRequest, perWrite, json, async (req, res) => {
    const args = parse(brainForgetSchema, req.body, res);
    if (args) { send(res, await brainForget(toolDeps())(ctxOf(keyOf(res)), args)); }
  });

  // ---------------------------------------------------------------- owner-only operations
  /** Bulk import: the one path that may set origin, so owner keys only. */
  app.post('/api/import', owner, perRequest, express.json({ limit: IMPORT_BODY_LIMIT_BYTES }), async (req, res) => {
    const args = parse(brainImportSchema, req.body, res);
    if (!args) { return; }
    // The source system labels provenance and must not forge a lineage identity the store reserves for itself.
    const sourceSystem = req.get('x-brain-source') ?? 'import';
    if (!IMPORT_SOURCE_PATTERN.test(sourceSystem) || (RESERVED_LINEAGE_SYSTEMS as readonly string[]).includes(sourceSystem)) {
      res.status(400).json({ ok: false, code: 'bad_input', error: 'x-brain-source must be a slug and may not be a reserved lineage system' });
      return;
    }
    const actor = { agent: importerAgent(keyOf(res).name), originClass: args.originClass };
    const summary = { created: 0, skipped: 0, rejected: [] as Array<{ externalId: string; error: string }> };
    for (const item of args.items) {
      try {
        const capturedAt = item.capturedAt ? new Date(item.capturedAt) : undefined;
        const { created } = await runtime.store.note(actor, {
          title: item.title, body: item.body, kind: item.kind, tags: item.tags, namespace: item.namespace, importance: item.importance,
          validFrom: capturedAt, source: { system: sourceSystem, externalId: item.externalId, path: item.path, capturedAt },
        });
        summary[created ? 'created' : 'skipped'] += 1;
      } catch (error) {
        if ((error as { code?: number }).code === 11000) { summary.skipped += 1; continue; }
        summary.rejected.push({ externalId: item.externalId, error: reasonOf(error) });
      }
    }
    send(res, { ok: true, data: summary });
  });

  /** Copy an episodic entry into the curated tier, optionally as a standing fact. */
  app.post('/api/promote', owner, perRequest, json, async (req, res) => {
    const args = parse(brainPromoteSchema, req.body, res);
    if (args) { send(res, await guard('brain_promote', () => runtime.store.promote(args.slug, { standing: args.standing ?? false }), logger)); }
  });

  /** Rebuild the SQLite index inside this process and swap it in; poll GET for the status. */
  app.post('/api/reindex', owner, perRequest, (_req, res) => {
    res.status(202).json({ ok: true, data: startReindex(runtime, { ...deps.reindex, logger }) });
  });
  app.get('/api/reindex', owner, perRequest, (_req, res) => {
    res.json({ ok: true, data: getReindexStatus() });
  });

  /** Retire everything one import system wrote (a source withdrawn wholesale). The agent tools select one entry. */
  app.post('/api/forget-source', owner, perRequest, json, async (req, res) => {
    const args = parse(brainForgetSourceSchema, req.body, res);
    if (!args) { return; }
    const actor = { agent: importerAgent(keyOf(res).name), originClass: 'owner' as const };
    send(res, await guard('brain_forget_source', () => runtime.store.forget(actor, { wholeSource: args.source }, args.reason), logger));
  });

  app.use((_req, res) => {
    res.status(404).json({ ok: false, code: 'not_found', error: 'No such route.' });
  });

  // Body-parser and unexpected errors: a short JSON answer, the reason in the log only.
  app.use((error: unknown, _req: Request, res: Response, _next: NextFunction) => {
    const status = (error as { status?: number; type?: string }).status;
    if (status === 413) {
      res.status(413).json({ ok: false, code: 'payload_too_large', error: 'The request body is too large.' });
      return;
    }
    if (status === 400) {
      res.status(400).json({ ok: false, code: 'bad_input', error: 'The request body is not valid JSON.' });
      return;
    }
    logger.error('request failed', { reason: reasonOf(error) });
    if (!res.headersSent) {
      res.status(500).json({ ok: false, code: 'internal', error: 'Internal error.' });
    }
  });
  return app;
}
