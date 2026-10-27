import { describe, expect, it } from 'vitest';

import { delimiter } from 'node:path';

import { MAX_BODY_CHARS, MAX_TITLE_CHARS } from '../brain/model.js';
import { findSecretShapes } from '../brain/redact.js';
import {
  IMPORT_PART_CHARS, type ImportItem, type ImportSink, type Importer, buildExcludeMatcher, createApiSink, repoNamespace, resolveExcludeTerms,
  resolveImportPaths, resolveRepoRoots, runImport, splitBody, splitOversize,
} from './framework.js';

const item = (over: Partial<ImportItem>): ImportItem => ({
  externalId: 'x', title: 'T', body: 'body', kind: 'memory', tags: [], namespace: 'shared', originClass: 'agent', ...over,
});

function stubImporter(items: ImportItem[]): Importer {
  return { source: 'stub', async *scan() { for (const i of items) { yield i; } } };
}

/** Shaped like an OpenClaw daily note: `## Entry n` sections of paragraphs and bullets, at least `chars` long. */
function dailyNotes(chars: number): string {
  const lines = ['# 2026-10-01', ''];
  let length = 0;
  for (let i = 0; length < chars; i += 1) {
    const section = [`## Entry ${i}`, '', `Paragraph ${i}: ${'talked through the plan '.repeat(20).trim()}`, '', `- follow-up ${i} ${'x'.repeat(60)}`, ''];
    lines.push(...section);
    length += section.join('\n').length + 1;
  }
  return lines.join('\n');
}

const isHighSurrogate = (code: number): boolean => code >= 0xd800 && code <= 0xdbff;

describe('import framework', () => {
  it('excludes paths matching the configured terms, rejects empty bodies, and batches by origin', async () => {
    const calls: Array<{ originClass: string; ids: string[] }> = [];
    const sink: ImportSink = {
      put: async (_source, originClass, items) => {
        calls.push({ originClass, ids: items.map((i) => i.externalId) });
        return { created: items.length, skipped: 0, rejected: [] };
      },
    };
    const importer = stubImporter([
      item({ externalId: 'a', path: '/srv/notes/project/a.md' }),
      item({ externalId: 'b', path: '/srv/notes/acme/x.md' }),
      item({ externalId: 'c', body: '   ' }),
      item({ externalId: 'd', originClass: 'owner' }),
      item({ externalId: 'e', namespace: 'repo:client-x' }),
    ]);
    const summary = await runImport(importer, sink, { paths: [], dryRun: false, exclude: buildExcludeMatcher(['acme', 'client-x']) });
    expect(summary).toEqual({ scanned: 5, excluded: 2, split: 0, created: 2, skipped: 0, retired: 0, rejected: 1 });
    expect(calls.map((c) => [c.originClass, c.ids])).toEqual([['agent', ['a']], ['owner', ['d']]]);
    // No terms, nothing excluded: there are no built-in exclusions.
    const none = await runImport(stubImporter([item({ externalId: 'b', path: '/srv/notes/acme/x.md' })]), sink, { paths: [], dryRun: false });
    expect(none.excluded).toBe(0);
  });

  it('puts every item in the namespace given instead of the derived one', async () => {
    const received: ImportItem[] = [];
    const sink: ImportSink = { put: async (_s, _o, items) => { received.push(...items); return { created: items.length, skipped: 0, rejected: [] }; } };
    await runImport(stubImporter([item({ externalId: 'a', namespace: 'repo:derived' })]), sink, { paths: [], dryRun: false, namespace: 'agent:override' });
    expect(received.map((i) => i.namespace)).toEqual(['agent:override']);
  });

  it('dry-run never calls the sink', async () => {
    let calls = 0;
    const sink: ImportSink = { put: async () => { calls += 1; return { created: 0, skipped: 0, rejected: [] }; } };
    const summary = await runImport(stubImporter([item({ externalId: 'a' })]), sink, { paths: [], dryRun: true });
    expect(calls).toBe(0);
    expect(summary.scanned).toBe(1);
  });

  it('api sink posts batches with the source header and reads the summary', async () => {
    const requests: Array<{ url: string; headers: Record<string, string>; body: unknown }> = [];
    const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
      requests.push({ url: String(url), headers: init?.headers as Record<string, string>, body: JSON.parse(String(init?.body)) });
      return new Response(JSON.stringify({ ok: true, data: { created: 1, skipped: 1, rejected: [] } }), { status: 200 });
    }) as typeof fetch;
    const sink = createApiSink({ origin: 'https://brain.example', key: 'bbk_test', fetchImpl });
    const result = await sink.put('claude-memory', 'agent', [item({ externalId: 'a' }), item({ externalId: 'b' })]);
    expect(result).toEqual({ created: 1, skipped: 1, retired: 0, rejected: [] });
    expect(requests[0].url).toBe('https://brain.example/api/import');
    expect(requests[0].headers['x-brain-source']).toBe('claude-memory');
    expect((requests[0].body as { originClass: string; items: unknown[] }).items).toHaveLength(2);
  });

  it('matches exclusion terms as whole words in paths, case-insensitively', () => {
    const exclude = buildExcludeMatcher(['acme', 'Client-X', ' ', '']);
    expect(exclude('/srv/notes/acme/docs/x.md')).toBe(true);
    expect(exclude('/srv/notes/ACME.wiki/page.md')).toBe(true);
    expect(exclude('/srv/notes/project/acmetools.md')).toBe(false);
    expect(exclude('-home-example-src-acme')).toBe(true);
    expect(exclude('/home/example/src/acme-1847-fix')).toBe(true);
    expect(exclude('acme--claude-worktrees-12-x')).toBe(true);
    expect(exclude('repo:acme')).toBe(true);
    expect(exclude('repo:client-x')).toBe(true);
    expect(exclude('repo:acmeit')).toBe(false);
    expect(exclude('task-group:abc')).toBe(false);
    expect(buildExcludeMatcher([])('/anything/acme')).toBe(false);
    expect(() => buildExcludeMatcher(['x'.repeat(101)])).toThrow(/longer than 100/u);
    // Terms are literal text, never patterns.
    expect(buildExcludeMatcher(['a.c'])('/x/abc/y')).toBe(false);
    expect(buildExcludeMatcher(['a.c'])('/x/a.c/y')).toBe(true);
  });

  it('names repo namespaces', () => {
    expect(repoNamespace('My Repo')).toBe('repo:my-repo');
    expect(repoNamespace('claude-code')).toBe('repo:claude-code');
    expect(repoNamespace('---')).toBe('shared');
  });

  it('takes exclusions and repo roots from the environment plus the flags', () => {
    expect(resolveExcludeTerms(['flagged'], { BRAIN_IMPORT_EXCLUDE: 'acme, client-x,' })).toEqual(['acme', 'client-x', 'flagged']);
    expect(resolveExcludeTerms([], {})).toEqual([]);
    expect(resolveRepoRoots(['/flag/root'], { BRAIN_IMPORT_REPO_ROOTS: ['/env/a', '/env/b'].join(delimiter) })).toEqual(['/env/a', '/env/b', '/flag/root']);
  });

  it('takes import paths from --path flags, else the env list, never a baked-in default', () => {
    expect(resolveImportPaths(['/srv/a', '/srv/b'], { BRAIN_IMPORT_PATHS: '/ignored' })).toEqual(['/srv/a', '/srv/b']);
    expect(resolveImportPaths([], { BRAIN_IMPORT_PATHS: ['/srv/a', ' /srv/b ', ''].join(delimiter) })).toEqual(['/srv/a', '/srv/b']);
    expect(resolveImportPaths([], {})).toEqual([]);
  });

  it('api sink rejects an item the route would refuse on its own and keeps each request under the item and byte limits', async () => {
    const requests: Array<{ ids: string[]; bytes: number }> = [];
    const fetchImpl = (async (_url: string | URL | Request, init?: RequestInit) => {
      const raw = String(init?.body);
      const { items } = JSON.parse(raw) as { items: Array<{ externalId: string }> };
      requests.push({ ids: items.map((i) => i.externalId), bytes: Buffer.byteLength(raw) });
      return new Response(JSON.stringify({ ok: true, data: { created: items.length, skipped: 0, rejected: [] } }), { status: 200 });
    }) as typeof fetch;
    const sink = createApiSink({ origin: 'https://brain.example', key: 'bbk_test', fetchImpl, maxRequestBytes: 250_000 });
    const result = await sink.put('openclaw-workspace', 'agent', [
      item({ externalId: 'a', body: 'a'.repeat(IMPORT_PART_CHARS) }),
      item({ externalId: 'long-tag', tags: ['t'.repeat(51)] }),
      item({ externalId: 'b', body: 'b'.repeat(IMPORT_PART_CHARS) }),
      item({ externalId: 'bad-date', capturedAt: new Date('updated_at: yesterday') }),
      item({ externalId: 'c', body: 'c'.repeat(IMPORT_PART_CHARS) }),
      item({ externalId: 'oversize', body: 'o'.repeat(MAX_BODY_CHARS + 1) }),
    ]);
    expect(result.created).toBe(3);
    expect(result.rejected.map((r) => r.externalId)).toEqual(['long-tag', 'bad-date', 'oversize']);
    expect(result.rejected[0].error).toMatch(/^tags\.0: Too big/u);
    expect(result.rejected[1].error).toBe('capturedAt: invalid date');
    expect(result.rejected[2].error).toBe(`body: Too big: expected string to have <=${MAX_BODY_CHARS} characters`);
    expect(requests.map((r) => r.ids)).toEqual([['a', 'b'], ['c']]);
    expect(requests.every((r) => r.bytes <= 250_000)).toBe(true);

    requests.length = 0;
    await sink.put('openclaw-workspace', 'agent', Array.from({ length: 150 }, (_, i) => item({ externalId: `m${i}` })));
    expect(requests.map((r) => r.ids.length)).toEqual([100, 50]);
  });

  it('api sink surfaces the route\'s own error when a request fails', async () => {
    const fetchImpl = (async () => new Response(JSON.stringify({ ok: false, error: 'Brain unavailable' }), { status: 503 })) as typeof fetch;
    const sink = createApiSink({ origin: 'https://brain.example', key: 'bbk_test', fetchImpl });
    await expect(sink.put('stub', 'agent', [item({})])).rejects.toThrow('import request failed with 503: Brain unavailable');
  });
});

describe('oversize import items', () => {
  it('splits a 250,000-character body into ordered parts under the limit, with stable ids and titles', () => {
    const body = dailyNotes(250_000);
    expect(body.length).toBeGreaterThanOrEqual(250_000);
    const original = item({
      externalId: 'helper-bot/memory/2026-10-01.md', title: 'helper-bot notes 2026-10-01', body, tags: ['source:openclaw', 'agent:helper-bot'],
      namespace: 'agent:helper-bot', capturedAt: new Date('2026-10-01T12:00:00Z'), path: '/mirror/helper-bot/memory/2026-10-01.md',
    });
    const parts = splitOversize(original);
    expect(parts.map((p) => p.externalId)).toEqual([1, 2, 3].map((n) => `helper-bot/memory/2026-10-01.md#part-${n}`));
    expect(parts.map((p) => p.title)).toEqual([1, 2, 3].map((n) => `helper-bot notes 2026-10-01 (part ${n}/3)`));
    expect(parts.every((p) => p.body.length <= IMPORT_PART_CHARS)).toBe(true);
    expect(IMPORT_PART_CHARS).toBeLessThan(MAX_BODY_CHARS);
    expect(parts.map((p) => p.body).join('')).toBe(body);
    for (const part of parts) {
      expect(part).toEqual({ ...original, externalId: part.externalId, title: part.title, body: part.body, parts: 3 });
    }
    // Deterministic, so a re-import posts the same identities with the same bodies.
    expect(splitOversize({ ...original })).toEqual(parts);
  });

  it('cuts at headings, so every part after the first opens a section', () => {
    const parts = splitBody(dailyNotes(250_000));
    expect(parts.length).toBeGreaterThan(1);
    expect(parts.slice(1).every((p) => p.startsWith('## Entry '))).toBe(true);
  });

  it('prefers a heading, then a blank line, then any line break, and cuts mid-line only when it must', () => {
    // Window (50, 100]: a heading at 59 beats the line after a blank one at 82.
    expect(splitBody(['x'.repeat(58), '## Heading', 'y'.repeat(10), '', 'z'.repeat(30), 'w'.repeat(30)].join('\n'), 100)[1]).toMatch(/^## Heading\n/u);
    // No heading: the line after the blank one (60) beats the later plain line break (81).
    expect(splitBody(['x'.repeat(58), '', 'y'.repeat(20), 'z'.repeat(20), 'w'.repeat(40)].join('\n'), 100)).toEqual([`${'x'.repeat(58)}\n\n`, `${'y'.repeat(20)}\n${'z'.repeat(20)}\n${'w'.repeat(40)}`]);
    // Only plain line breaks: the latest one in the window.
    expect(splitBody([`${'x'.repeat(70)}`, `${'y'.repeat(70)}`].join('\n'), 100)).toEqual([`${'x'.repeat(70)}\n`, 'y'.repeat(70)]);
    // No line break at all: a hard cut at the limit.
    expect(splitBody('q'.repeat(250), 100)).toEqual(['q'.repeat(100), 'q'.repeat(100), 'q'.repeat(50)]);
  });

  it('never treats a heading inside fenced code as a boundary, and never splits a surrogate pair', () => {
    const fenced = ['x'.repeat(52), '```bash', '# not a heading', 'echo hi', '```', 'y'.repeat(60)].join('\n');
    expect(splitBody(fenced, 100)).toEqual([fenced.slice(0, fenced.indexOf('y')), 'y'.repeat(60)]);
    const emoji = `${'a'.repeat(99)}😀${'b'.repeat(50)}`;
    expect(splitBody(emoji, 100)).toEqual(['a'.repeat(99), `😀${'b'.repeat(50)}`]);
  });

  it('always yields parts within the limit that concatenate back to the body', () => {
    let seed = 7;
    const random = (n: number): number => {
      seed = (seed * 1_103_515_245 + 12_345) % 2 ** 31;
      return seed % n;
    };
    const pieces = ['# H', '## Sub', '', 'a line of text', '```', '~~~~', '- item', 'x'.repeat(150), '😀😀', 'crlf\r'];
    for (let round = 0; round < 300; round += 1) {
      const glue = random(4) === 0 ? '' : '\n';
      const body = ['start', ...Array.from({ length: 5 + random(80) }, () => pieces[random(pieces.length)])].join(glue);
      const maxChars = 20 + random(200);
      const parts = splitBody(body, maxChars);
      expect(parts.join('')).toBe(body);
      expect(parts.every((p) => p.length > 0 && p.length <= maxChars)).toBe(true);
      expect(parts.slice(0, -1).some((p) => isHighSurrogate(p.charCodeAt(p.length - 1)))).toBe(false);
      expect(splitBody(body, maxChars)).toEqual(parts);
    }
  });

  it('leaves an item that fits untouched, up to the limit itself', () => {
    const small = item({ externalId: 'small', title: 'Small', body: 'fits easily' });
    expect(splitOversize(small)).toEqual([small]);
    expect(splitOversize(small)[0]).toBe(small);
    const atLimit = item({ externalId: 'edge', body: 'e'.repeat(MAX_BODY_CHARS) });
    expect(splitOversize(atLimit)[0]).toBe(atLimit);
  });

  it('shortens a long title so the part suffix still fits the title limit', () => {
    const parts = splitOversize(item({ title: 'T'.repeat(MAX_TITLE_CHARS), body: 'y'.repeat(MAX_BODY_CHARS + 1) }));
    expect(parts).toHaveLength(2);
    expect(parts.map((p) => p.title.length)).toEqual([MAX_TITLE_CHARS, MAX_TITLE_CHARS]);
    expect(parts.map((p) => p.title.slice(-10))).toEqual(['(part 1/2)', '(part 2/2)']);
  });

  it('the sink never receives an oversize body, and parts keep their order across batches', async () => {
    const received: ImportItem[] = [];
    const sink: ImportSink = {
      put: async (_source, _originClass, items) => {
        received.push(...items);
        return { created: items.length, skipped: 0, rejected: [] };
      },
    };
    const body = dailyNotes(250_000);
    const logs: string[] = [];
    const importer = stubImporter([item({ externalId: 'before' }), item({ externalId: 'big', title: 'Big day', body }), item({ externalId: 'after' })]);
    const summary = await runImport(importer, sink, { paths: [], dryRun: false, batchSize: 2, log: (line) => logs.push(line) });
    expect(received.every((i) => i.body.length <= MAX_BODY_CHARS)).toBe(true);
    expect(received.map((i) => i.externalId)).toEqual(['before', 'big#part-1', 'big#part-2', 'big#part-3', 'after']);
    expect(summary).toEqual({ scanned: 3, excluded: 0, split: 1, created: 5, skipped: 0, retired: 0, rejected: 0 });
    expect(logs).toContain(`split big (${body.length} chars) into 3 parts`);
  });

  it('rejects an oversize item with a secret shape whole, as the store does for one that fits, whatever a cut would hide', async () => {
    // A key the first cut (a hard one at 90,000) lands inside: the store's per-entry gate would pass both halves.
    const key = `bbk_${'a'.repeat(43)}`;
    const straddled = `${'x'.repeat(89_989)} ${key}${'y'.repeat(20_000)}\n${'z'.repeat(120_000)}`;
    expect(splitBody(straddled).map((part) => findSecretShapes(part))).toEqual([[], [], []]);
    // A private key the cut separates from its BEGIN line: its pattern matches only that line, so the part holding
    // the key itself would pass the per-entry gate.
    const dashes = '-'.repeat(5);
    const pem = [`${dashes}BEGIN RSA PRIVATE KEY${dashes}`, ...Array.from({ length: 5 }, (_, i) => `MII${i}${'A'.repeat(60)}`), `${dashes}END RSA PRIVATE KEY${dashes}`].join('\n');
    const headerCut = `${'x'.repeat(89_960)}\n${pem}\n${'y'.repeat(120_000)}`;
    expect(splitBody(headerCut).map((part) => findSecretShapes(part))).toEqual([['private-key'], [], []]);

    const received: string[] = [];
    const sink: ImportSink = {
      put: async (_source, _originClass, items) => {
        received.push(...items.map((i) => i.externalId));
        return { created: items.length, skipped: 0, rejected: [] };
      },
    };
    const logs: string[] = [];
    const importer = stubImporter([item({ externalId: 'straddled', body: straddled }), item({ externalId: 'pem', body: headerCut }), item({ externalId: 'clean' })]);
    const summary = await runImport(importer, sink, { paths: [], dryRun: false, log: (line) => logs.push(line) });
    expect(received).toEqual(['clean']);
    expect(summary).toEqual({ scanned: 3, excluded: 0, split: 0, created: 1, skipped: 0, retired: 0, rejected: 2 });
    expect(logs).toEqual([
      'rejected straddled: body contains a secret-shaped value: brain-api-key',
      'rejected pem: body contains a secret-shaped value: private-key',
    ]);
  });
});
