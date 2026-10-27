#!/usr/bin/env node
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { parseArgs } from 'node:util';

import { KEY_ROLES, type KeyRole, addKey, mintKey, readKeysFile, revokeKey } from './auth/keys.js';
import { dotenvValue, loadServerConfig } from './config.js';
import { renderTable } from './eval/score.js';
import { runLiveEval, runOfflineEval, seedRequests } from './eval/run.js';
import { claudeMemoryImporter } from './importers/claude-memory.js';
import { codexMemoryImporter } from './importers/codex-memory.js';
import {
  type ImportItem, type Importer, buildExcludeMatcher, createApiSink, resolveExcludeTerms, resolveImportPaths, resolveRepoRoots, runImport,
} from './importers/framework.js';
import { createMarkdownImporter } from './importers/markdown.js';
import { openclawWorkspaceImporter } from './importers/openclaw-workspace.js';
import { createLogger } from './log.js';
import { startServer } from './server.js';
import { VERSION } from './version.js';

const HELP = `badland-brain ${VERSION}: shared memory for Claude Code, Codex, ChatGPT and any MCP client

Usage: badland-brain <command> [options]

Server
  serve                               Start the server (settings come from BRAIN_* variables; see .env.example)
  keys mint --name <name> --role <read|agent|owner> [--namespace <ns>]... [--expires-days <n>] [--no-write]
                                      Mint a key: the key is printed once on stdout, only its hash is stored
  keys list [--json]                  The keys the server accepts (never a key or hash)
  keys revoke <id|name>               Remove a key from the keys file

Owner operations (talk to a running server at BRAIN_URL with the owner key in BRAIN_KEY or BRAIN_KEY_FILE)
  import <source> [--path <dir>]... [--exclude <term>]... [--repo-root <dir>]... [--namespace <ns>] [--origin <class>] [--dry-run]
                                      Sources: claude-memory, codex-memory, openclaw-workspace, markdown
  promote <slug> [--standing]         Copy an episodic entry into the curated tier (standing: loaded by brain_context)
  supersede <slug> --reason <text> (--body <text> | --body-file <file|->) [--title <text>] [--expected-hash <hash>]
  forget <slug> --reason <text>       Soft-delete one entry, curated ones included
  forget-source <system> --reason <text>
                                      Retire everything one import system wrote
  reindex [--no-wait]                 Rebuild the SQLite index from MongoDB and swap it in
  health                              The server's /healthz

Evaluation
  eval                                Offline: synthetic fixtures, fake embedder, a throwaway database on BRAIN_MONGODB_URI
  eval --seed                         Import the fixtures into the running brain (identities eval/<id>)
  eval --live [--out <file>]          The golden questions against the real store and index, read-only

Global options
  --env-file <path>                   Load variables from a dotenv file first (existing variables win)
  -h, --help | -v, --version
`;

class UsageError extends Error {}

const print = (value: unknown): void => {
  process.stdout.write(`${typeof value === 'string' ? value : JSON.stringify(value, null, 2)}\n`);
};

// ------------------------------------------------------------------ talking to a running server
const serverUrl = (): string => (process.env.BRAIN_URL?.trim() || `http://127.0.0.1:${process.env.BRAIN_PORT?.trim() || '8270'}`).replace(/\/+$/u, '');

/** BRAIN_KEY, else the contents of BRAIN_KEY_FILE. Never a command-line argument, which other users can read. */
function ownerKey(): string {
  const direct = process.env.BRAIN_KEY?.trim();
  if (direct) {
    return direct;
  }
  const file = process.env.BRAIN_KEY_FILE?.trim();
  if (file && existsSync(file)) {
    const text = readFileSync(file, 'utf8');
    const line = [...text.matchAll(/^[ \t]*(?:export[ \t]+)?BRAIN_KEY=(.*)$/gmu)].at(-1)?.[1];
    const key = dotenvValue(line ?? text);
    if (key) {
      return key;
    }
  }
  throw new UsageError('this command needs an owner key in BRAIN_KEY or BRAIN_KEY_FILE (mint one with: badland-brain keys mint --name <name> --role owner)');
}

async function api<T>(method: 'GET' | 'POST', path: string, body?: unknown, headers: Record<string, string> = {}): Promise<T> {
  const response = await fetch(`${serverUrl()}${path}`, {
    method,
    headers: { authorization: `Bearer ${ownerKey()}`, accept: 'application/json', ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const json = (await response.json().catch(() => null)) as { ok?: boolean; data?: T; error?: string } | null;
  if (!response.ok || !json?.ok) {
    throw new Error(`${method} ${path} failed with ${response.status}${json?.error ? `: ${json.error}` : ''}`);
  }
  return json.data as T;
}

// ------------------------------------------------------------------ commands
async function serve(): Promise<void> {
  const config = loadServerConfig();
  const logger = createLogger(config.logLevel);
  const running = await startServer(config, { logger });
  let stopping = false;
  const stop = (signal: string): void => {
    if (stopping) {
      return;
    }
    stopping = true;
    logger.info('shutting down', { signal });
    running.close().then(() => process.exit(0), () => process.exit(1));
  };
  process.on('SIGINT', () => stop('SIGINT'));
  process.on('SIGTERM', () => stop('SIGTERM'));
}

function keys(args: string[]): void {
  const [action, ...rest] = args;
  const config = loadServerConfig();
  if (action === 'mint') {
    const { values } = parseArgs({ args: rest, options: {
      name: { type: 'string' }, role: { type: 'string' }, namespace: { type: 'string', multiple: true },
      'expires-days': { type: 'string' }, 'no-write': { type: 'boolean' },
    }, strict: true });
    if (!values.name || !values.role) {
      throw new UsageError('keys mint needs --name and --role');
    }
    if (!(KEY_ROLES as readonly string[]).includes(values.role)) {
      throw new UsageError(`--role must be one of ${KEY_ROLES.join(', ')}`);
    }
    const expiresDays = values['expires-days'] === undefined ? undefined : Number(values['expires-days']);
    if (expiresDays !== undefined && (!Number.isInteger(expiresDays) || expiresDays < 1 || expiresDays > 3650)) {
      throw new UsageError('--expires-days must be a whole number of days from 1 to 3650');
    }
    const { raw, record } = mintKey({ name: values.name, role: values.role as KeyRole, namespaces: values.namespace, expiresDays });
    if (values['no-write']) {
      process.stderr.write(`Add this record to BRAIN_KEYS (it holds only the key's hash):\n${JSON.stringify(record)}\n`);
    } else {
      addKey(config.keysFile, record);
      process.stderr.write(`Saved ${record.role} key ${record.id} (${record.name}) to ${config.keysFile}. The key is shown once:\n`);
    }
    process.stdout.write(`${raw}\n`);
    return;
  }
  if (action === 'list') {
    const { values } = parseArgs({ args: rest, options: { json: { type: 'boolean' } }, strict: true });
    const rows = readKeysFile(config.keysFile).map(({ hash: _hash, ...visible }) => visible);
    if (values.json) {
      print(rows);
      return;
    }
    if (rows.length === 0) {
      print(`No keys in ${config.keysFile}.`);
      return;
    }
    print(rows.map((row) => `${row.id}  ${row.role.padEnd(5)}  ${row.name}${row.namespaces ? `  [${row.namespaces.join(', ')}]` : ''}${row.expiresAt ? `  expires ${row.expiresAt.slice(0, 10)}` : ''}`).join('\n'));
    return;
  }
  if (action === 'revoke') {
    const target = rest[0];
    if (!target) {
      throw new UsageError('keys revoke needs a key id or name');
    }
    const removed = revokeKey(config.keysFile, target);
    if (removed.length === 0) {
      throw new UsageError(`no key with id or name ${target}`);
    }
    print({ revoked: removed.map((record) => ({ id: record.id, name: record.name })) });
    return;
  }
  throw new UsageError('keys needs mint, list or revoke');
}

const ORIGINS = ['owner', 'agent', 'untrusted'] as const;

async function importCommand(args: string[]): Promise<void> {
  const { values, positionals } = parseArgs({ args, allowPositionals: true, options: {
    path: { type: 'string', multiple: true }, exclude: { type: 'string', multiple: true }, 'repo-root': { type: 'string', multiple: true },
    namespace: { type: 'string' }, origin: { type: 'string' }, 'dry-run': { type: 'boolean' },
  }, strict: true });
  const source = positionals[0];
  if (values.origin !== undefined && !(ORIGINS as readonly string[]).includes(values.origin)) {
    throw new UsageError(`--origin must be one of ${ORIGINS.join(', ')}`);
  }
  if (values.origin !== undefined && source !== 'markdown') {
    throw new UsageError('--origin applies to the markdown source only; the other importers set their own');
  }
  const importers: Record<string, Importer> = {
    'claude-memory': claudeMemoryImporter,
    'codex-memory': codexMemoryImporter,
    'openclaw-workspace': openclawWorkspaceImporter,
    markdown: createMarkdownImporter({ originClass: values.origin as ImportItem['originClass'] | undefined }),
  };
  const importer = source ? importers[source] : undefined;
  if (!importer) {
    throw new UsageError(`import needs a source: ${Object.keys(importers).join(', ')}`);
  }
  const paths = resolveImportPaths(values.path ?? [], process.env);
  if (paths.length === 0) {
    throw new UsageError('import needs at least one --path, or BRAIN_IMPORT_PATHS');
  }
  const dryRun = values['dry-run'] === true;
  const sink = createApiSink({ origin: serverUrl(), key: dryRun ? '' : ownerKey() });
  const summary = await runImport(importer, sink, {
    paths,
    dryRun,
    exclude: buildExcludeMatcher(resolveExcludeTerms(values.exclude ?? [], process.env)),
    repoRoots: resolveRepoRoots(values['repo-root'] ?? [], process.env),
    namespace: values.namespace,
    log: (line) => process.stderr.write(`${line}\n`),
  });
  print({ source, dryRun, paths, ...summary });
}

async function evalCommand(args: string[]): Promise<void> {
  const { values } = parseArgs({ args, options: { live: { type: 'boolean' }, seed: { type: 'boolean' }, out: { type: 'string' } }, strict: true });
  const config = loadServerConfig();
  if (values.seed) {
    const [all, revisions] = seedRequests();
    const first = await api('POST', '/api/import', all, { 'x-brain-source': 'eval' });
    const second = await api('POST', '/api/import', revisions, { 'x-brain-source': 'eval' });
    print({ seeded: true, fixtures: first, revisions: second });
    return;
  }
  const result = values.live ? await runLiveEval({ mongoUri: config.mongoUri, config: config.brain }) : await runOfflineEval(config.mongoUri);
  print(`${renderTable(result.outcomes, result.summary)}\n${result.mode} eval · model ${result.model} · abstain below similarity ${result.abstainThreshold}`);
  if (values.out) {
    writeFileSync(values.out, `${JSON.stringify(result, null, 2)}\n`);
    process.stderr.write(`wrote ${values.out}\n`);
  }
  if (result.summary.revocationLeaks > 0 || result.summary.revocationMisses > 0) {
    process.exitCode = 2;
  }
}

async function reindex(args: string[]): Promise<void> {
  const { values } = parseArgs({ args, options: { 'no-wait': { type: 'boolean' } }, strict: true });
  type Status = { state: string; startedAt: string | null; error: string | null };
  let status = await api<Status>('POST', '/api/reindex');
  process.stderr.write(`reindex ${status.state} (started ${status.startedAt ?? 'earlier'})\n`);
  const deadline = Date.now() + 6 * 60 * 60 * 1000;
  while (!values['no-wait'] && status.state === 'running' && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 2000));
    status = await api<Status>('GET', '/api/reindex');
  }
  print(status);
  if (!values['no-wait'] && status.state !== 'done') {
    process.exitCode = 2;
  }
}

function readBody(values: { body?: string; 'body-file'?: string }): string {
  if (values.body !== undefined && values['body-file'] !== undefined) {
    throw new UsageError('pass --body or --body-file, not both');
  }
  if (values['body-file'] !== undefined) {
    return readFileSync(values['body-file'] === '-' ? 0 : values['body-file'], 'utf8');
  }
  if (values.body !== undefined) {
    return values.body;
  }
  throw new UsageError('supersede needs --body or --body-file');
}

async function main(argv: string[]): Promise<void> {
  const envFileAt = argv.indexOf('--env-file');
  if (envFileAt !== -1) {
    const file = argv[envFileAt + 1];
    if (!file) {
      throw new UsageError('--env-file needs a path');
    }
    process.loadEnvFile(file);
    argv = [...argv.slice(0, envFileAt), ...argv.slice(envFileAt + 2)];
  }
  const [command, ...rest] = argv;
  switch (command) {
    case undefined:
    case 'help':
    case '-h':
    case '--help':
      print(HELP);
      return;
    case 'version':
    case '-v':
    case '--version':
      print(VERSION);
      return;
    case 'serve':
      return serve();
    case 'keys':
      return keys(rest);
    case 'import':
      return importCommand(rest);
    case 'promote': {
      const { values, positionals } = parseArgs({ args: rest, allowPositionals: true, options: { standing: { type: 'boolean' } }, strict: true });
      if (!positionals[0]) { throw new UsageError('promote needs a slug'); }
      print(await api('POST', '/api/promote', { slug: positionals[0], standing: values.standing === true }));
      return;
    }
    case 'supersede': {
      const { values, positionals } = parseArgs({ args: rest, allowPositionals: true, options: {
        reason: { type: 'string' }, body: { type: 'string' }, 'body-file': { type: 'string' }, title: { type: 'string' }, 'expected-hash': { type: 'string' },
      }, strict: true });
      const slug = positionals[0];
      if (!slug || !values.reason) { throw new UsageError('supersede needs a slug and --reason'); }
      const body = readBody(values);
      // Without --expected-hash, the hash of the version current right now: the compare-and-set still refuses a change that lands meanwhile.
      const expectedHash = values['expected-hash'] ?? (await api<{ contentHash: string }>('GET', `/api/entries/${encodeURIComponent(slug)}`)).contentHash;
      print(await api('POST', '/api/supersede', { slug, body, reason: values.reason, expectedHash, ...(values.title ? { title: values.title } : {}) }));
      return;
    }
    case 'forget': {
      const { values, positionals } = parseArgs({ args: rest, allowPositionals: true, options: { reason: { type: 'string' } }, strict: true });
      if (!positionals[0] || !values.reason) { throw new UsageError('forget needs a slug and --reason'); }
      print(await api('POST', '/api/forget', { slug: positionals[0], reason: values.reason }));
      return;
    }
    case 'forget-source': {
      const { values, positionals } = parseArgs({ args: rest, allowPositionals: true, options: { reason: { type: 'string' } }, strict: true });
      if (!positionals[0] || !values.reason) { throw new UsageError('forget-source needs an import system and --reason'); }
      print(await api('POST', '/api/forget-source', { source: { system: positionals[0] }, reason: values.reason }));
      return;
    }
    case 'reindex':
      return reindex(rest);
    case 'health': {
      const response = await fetch(`${serverUrl()}/healthz`);
      print(await response.json());
      return;
    }
    case 'eval':
      return evalCommand(rest);
    default:
      throw new UsageError(`unknown command ${command}; run badland-brain --help`);
  }
}

main(process.argv.slice(2)).catch((error: unknown) => {
  if (error instanceof UsageError || (error as { code?: string }).code?.startsWith('ERR_PARSE_ARGS')) {
    process.stderr.write(`badland-brain: ${(error as Error).message}\n`);
    process.exitCode = 64;
    return;
  }
  process.stderr.write(`badland-brain: ${(error as Error).message ?? String(error)}\n`);
  process.exitCode = 1;
});

