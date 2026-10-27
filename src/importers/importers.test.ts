import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import { MAX_USER_TAGS } from '../brain/model.js';
import { brainImportItemSchema } from '../mcp/schemas.js';
import { claudeMemoryImporter } from './claude-memory.js';
import { codexMemoryImporter, namespaceOfCwd, splitTaskGroups } from './codex-memory.js';
import { type ImportItem, type Importer, type ScanOptions, buildExcludeMatcher } from './framework.js';
import { frontmatterList, parseFrontmatter } from './frontmatter.js';
import { createMarkdownImporter } from './markdown.js';
import { openclawWorkspaceImporter, stripCcSync } from './openclaw-workspace.js';
import { encodeProjectPath, repoOfMemoryDir, repoOfPath } from './repos.js';

async function collect(importer: Importer, paths: string[], opts: Partial<ScanOptions> = {}): Promise<ImportItem[]> {
  const out: ImportItem[] = [];
  for await (const item of importer.scan({ paths, exclude: () => false, repoRoots: [], ...opts })) {
    out.push(item);
  }
  return out;
}

const temp = (): string => mkdtempSync(join(tmpdir(), 'brain-import-'));

describe('frontmatter', () => {
  it('parses flat keys, one-level nested keys and list items, and strips the block', () => {
    const { data, body } = parseFrontmatter('---\nname: Storage volume\ndescription: "200GB volume"\nmetadata:\n  type: reference\ntags:\n  - ops\n  - storage\n---\n\n# Body\ntext');
    expect(data).toEqual({ name: 'Storage volume', description: '200GB volume', 'metadata.type': 'reference', tags: 'ops, storage' });
    expect(body).toBe('# Body\ntext');
    expect(parseFrontmatter('no frontmatter')).toEqual({ data: {}, body: 'no frontmatter' });
    expect(frontmatterList('[a, "b", c]')).toEqual(['a', 'b', 'c']);
    expect(frontmatterList('ops, storage')).toEqual(['ops', 'storage']);
    expect(frontmatterList(undefined)).toEqual([]);
  });
});

describe('repo names', () => {
  it('names the repo of a path from the longest repo root holding it, else its last directory', () => {
    expect(repoOfPath('/srv/code/web-app/packages/api', ['/srv/code'])).toBe('web-app');
    expect(repoOfPath('/srv/code/web-app/.claude/worktrees/fix-1', [])).toBe('web-app');
    expect(repoOfPath('/srv/code/web-app/.worktrees/fix-1', ['/srv/code'])).toBe('web-app');
    expect(repoOfPath('/srv/code/web-app-current-info-20260918', ['/srv/code'])).toBe('web-app-current-info');
    expect(repoOfPath('/srv/code/nested/deep', ['/srv', '/srv/code'])).toBe('nested');
    expect(repoOfPath('/home/example/projects/notes', [])).toBe('notes');
  });

  it('decodes a Claude Code project directory against the repo roots, then the home directory', () => {
    const home = '/home/example';
    expect(encodeProjectPath('/home/example/src/my.repo')).toBe('-home-example-src-my-repo');
    expect(repoOfMemoryDir(`/home/example/.claude/projects/${encodeProjectPath('/home/example/src/web-app')}/memory`, ['/home/example/src'], home)).toBe('web-app');
    expect(repoOfMemoryDir(`/x/${encodeProjectPath('/home/example/src/web-app/.claude/worktrees/fix-2')}/memory`, ['/home/example/src'], home)).toBe('web-app');
    expect(repoOfMemoryDir(`/x/${encodeProjectPath('/home/example/src/web-app')}/memory`, [], home)).toBe('src-web-app');
    expect(repoOfMemoryDir(`/x/${encodeProjectPath('/home/example')}/memory`, [], home)).toBe('example');
    expect(repoOfMemoryDir('/x/-opt-elsewhere-tool/memory', [], home)).toBe('opt-elsewhere-tool');
    expect(repoOfMemoryDir('/srv/memory-homes/Web-App', [], home)).toBe('web-app');
  });
});

describe('claude-memory importer', () => {
  it('imports topic files, skips index and analysis, derives repo and kind', async () => {
    const root = temp();
    const dir = join(root, 'web-app');
    mkdirSync(join(dir, '.analysis'), { recursive: true });
    writeFileSync(join(dir, 'volume.md'), '---\nname: Storage volume\ndescription: overflow\nmetadata:\n  type: reference\n---\n# Volume\nbody');
    writeFileSync(join(dir, 'feedback-x.md'), '---\nname: Feedback X\ntype: feedback\n---\nDo X.');
    writeFileSync(join(dir, 'MEMORY.md'), '# index');
    writeFileSync(join(dir, 'DREAMS.md'), '# diary');
    writeFileSync(join(dir, '.analysis', 'x.md'), 'analysis');
    const items = await collect(claudeMemoryImporter, [dir]);
    expect(items.map((i) => i.externalId).sort()).toEqual(['web-app/feedback-x.md', 'web-app/volume.md']);
    const volume = items.find((i) => i.externalId === 'web-app/volume.md');
    expect(volume).toMatchObject({ title: 'Storage volume', kind: 'reference', namespace: 'repo:web-app', originClass: 'agent' });
    expect(volume?.body.startsWith('> overflow\n\n# Volume')).toBe(true);
    expect(volume?.tags).toEqual(['source:claude-memory', 'repo:web-app', 'type:reference']);
    expect(items.find((i) => i.externalId === 'web-app/feedback-x.md')?.kind).toBe('memory');
    expect(await collect(claudeMemoryImporter, [dir], { exclude: buildExcludeMatcher(['web-app']) })).toEqual([]);
  });
});

describe('codex-memory importer', () => {
  it('splits task groups, skips excluded working directories, and imports rollout summaries', async () => {
    const dir = temp();
    mkdirSync(join(dir, 'rollout_summaries'));
    writeFileSync(join(dir, 'MEMORY.md'), [
      '# Task Group: Web app chat formatting', 'scope: ship', 'applies_to: cwd=/srv/code/web-app plus /srv/code/web-app-x', '## Task 1', 'done',
      '# Task Group: Client portal', 'applies_to: cwd=/srv/code/client-portal', 'client-confidential notes',
    ].join('\n'));
    writeFileSync(join(dir, 'rollout_summaries', '2026-09-18T08-34-37-x.md'), 'thread_id: t\nupdated_at: 2026-09-18T19:40:16+00:00\ncwd: /srv/code/web-app\n\n# Shipped chat formatting\n\nOutcome: success');
    writeFileSync(join(dir, 'rollout_summaries', 'portal.md'), 'cwd: /srv/code/client-portal\n\n# Portal work');
    writeFileSync(join(dir, 'raw_memories.md'), '# Task Group: never read');
    const items = await collect(codexMemoryImporter, [dir], { exclude: buildExcludeMatcher(['client-portal']), repoRoots: ['/srv/code'] });
    expect(items.map((i) => i.externalId)).toEqual([expect.stringMatching(/^task-group:[0-9a-f]{12}$/u), 'rollout:2026-09-18T08-34-37-x.md']);
    expect(items[0]).toMatchObject({ title: 'Web app chat formatting', kind: 'memory', namespace: 'repo:web-app' });
    expect(items[1]).toMatchObject({ title: 'Shipped chat formatting', kind: 'handoff', namespace: 'repo:web-app' });
    expect(items[1].capturedAt?.toISOString()).toBe('2026-09-18T19:40:16.000Z');
    expect(splitTaskGroups('')).toEqual([]);
    expect(namespaceOfCwd('cwd=/srv/code/web-app-current-info-20260918', ['/srv/code'])).toBe('repo:web-app-current-info');
    expect(namespaceOfCwd('no cwd here')).toBe('shared');
    // Without the exclusion term, the second group comes through: nothing is excluded by default.
    expect(await collect(codexMemoryImporter, [dir])).toHaveLength(4);
  });
});

describe('openclaw-workspace importer', () => {
  it('strips the cc-sync block, imports MEMORY.md, daily notes and topics, skips dreaming', async () => {
    const root = temp();
    const dir = join(root, 'helper-bot');
    mkdirSync(join(dir, 'memory', 'topics'), { recursive: true });
    mkdirSync(join(dir, 'memory', 'dreaming', 'deep'), { recursive: true });
    writeFileSync(join(dir, 'MEMORY.md'), '# MEMORY.md\n\n## Who I Am\nA helper.');
    writeFileSync(join(dir, 'memory', '2026-09-19.md'), '# 2026-09-19\n\n<!-- cc-sync -->\n## Claude Code Context\n> Synced\n\n### admin-api-setup\nsynced body\n\n## Evening\nReviewed the release notes.');
    writeFileSync(join(dir, 'memory', 'topics', 'speakers.md'), '# Speaker setup\nvolume 30');
    writeFileSync(join(dir, 'memory', 'dreaming', 'deep', '2026-09-19.md'), 'dream');
    const items = await collect(openclawWorkspaceImporter, [dir]);
    expect(items.map((i) => i.externalId)).toEqual(['helper-bot/MEMORY.md', 'helper-bot/memory/2026-09-19.md', 'helper-bot/memory/topics/speakers.md']);
    const daily = items[1];
    expect(daily.body).not.toContain('synced body');
    expect(daily.body).toContain('## Evening');
    expect(daily).toMatchObject({ kind: 'memory', namespace: 'agent:helper-bot', originClass: 'agent' });
    expect(daily.capturedAt?.toISOString()).toBe('2026-09-19T12:00:00.000Z');
    expect(items[2]).toMatchObject({ title: 'Speaker setup', kind: 'reference' });
    expect(stripCcSync('a\n<!-- cc-sync -->\n## Claude Code Context\nx\n')).toBe('a');
  });

  it('strips a closed cc-sync block whole, though the mirrored memories carry their own ## headings', () => {
    const mirrored = '### admin-stack\n\n---\nname: admin-stack\n---\n\n## Architecture\nmirrored one\n\n## Why\nmirrored two\n\n### service-ports\n\n## Ports\nmirrored three\n';
    const note = `# 2026-10-24\n\n## ops watcher (00:32Z)\n- kept before\n\n<!-- cc-sync -->\n## Claude Code Context\n> Synced\n\n${mirrored}<!-- /cc-sync -->\n\n## Evening\nkept after`;
    const stripped = stripCcSync(note);
    expect(stripped).not.toMatch(/mirrored|Claude Code Context|cc-sync/u);
    expect(stripped).toBe('# 2026-10-24\n\n## ops watcher (00:32Z)\n- kept before\n\n## Evening\nkept after');
  });

  it('ends an unclosed legacy block at its next heading, never at a later block\'s close marker', () => {
    const note = 'a\n<!-- cc-sync -->\n## Claude Code Context\nold mirror\n## Evening\nkept\n<!-- cc-sync -->\n## Claude Code Context\n## Ports\nnew mirror\n<!-- /cc-sync -->\nz';
    expect(stripCcSync(note)).toBe('a\n## Evening\nkept\nz');
    const adjacent = 'a\n<!-- cc-sync -->\n## Claude Code Context\nold\n<!-- cc-sync -->\n## Claude Code Context\n## Ports\nnew mirror\n<!-- /cc-sync -->\nz';
    expect(stripCcSync(adjacent)).toBe('a\nz');
  });

  it('skips a daily note that holds nothing but a mirrored block', async () => {
    const dir = join(temp(), 'helper-bot');
    mkdirSync(join(dir, 'memory'), { recursive: true });
    writeFileSync(join(dir, 'memory', '2026-10-24.md'), '<!-- cc-sync -->\n## Claude Code Context\n### a\n## Why\nmirrored\n<!-- /cc-sync -->\n');
    writeFileSync(join(dir, 'memory', '2026-10-25.md'), '# 2026-10-25\n\nreal note');
    const items = await collect(openclawWorkspaceImporter, [dir]);
    expect(items.map((i) => i.externalId)).toEqual(['helper-bot/memory/2026-10-25.md']);
  });
});

describe('import identities', () => {
  it('keeps same-named markdown folders and Codex task groups from different directories apart, and stable per directory', async () => {
    const roots = [join(temp(), 'docs'), join(temp(), 'docs')];
    for (const root of roots) {
      mkdirSync(root, { recursive: true });
      writeFileSync(join(root, 'index.md'), `# Index\n\nthe index of ${root}`);
    }
    const ids = (await collect(createMarkdownImporter(), roots)).map((i) => i.externalId);
    expect(new Set(ids).size).toBe(2);
    expect((await collect(createMarkdownImporter(), roots)).map((i) => i.externalId)).toEqual(ids);
    const dirs = [temp(), temp()];
    for (const dir of dirs) {
      writeFileSync(join(dir, 'MEMORY.md'), `# Task Group: Release workflow\napplies_to: cwd=${dir}\nsteps for ${dir}`);
    }
    const groups = (await collect(codexMemoryImporter, dirs)).map((i) => i.externalId);
    expect(new Set(groups).size).toBe(2);
    expect((await collect(codexMemoryImporter, dirs)).map((i) => i.externalId)).toEqual(groups);
  });

  it('cuts tags derived from long repo names to the tag limit, so their items still import', async () => {
    const dir = join(temp(), `-srv-${'very-long-directory-name-'.repeat(4)}project`, 'memory');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'note.md'), `---\nname: Note\ntype: ${'t'.repeat(60)}\n---\nbody`);
    const claude = await collect(claudeMemoryImporter, [dir]);
    const codexDir = temp();
    writeFileSync(join(codexDir, 'MEMORY.md'), `# Task Group: Long repo\napplies_to: cwd=/srv/code/${'r'.repeat(60)}\nbody`);
    const codex = await collect(codexMemoryImporter, [codexDir], { repoRoots: ['/srv/code'] });
    for (const item of [...claude, ...codex]) {
      expect(item.tags.every((tag) => tag.length <= 50)).toBe(true);
      expect(brainImportItemSchema.safeParse({ ...item, capturedAt: item.capturedAt?.toISOString() }).success).toBe(true);
    }
    expect(claude).toHaveLength(1);
    expect(codex).toHaveLength(1);
  });
});

describe('markdown importer', () => {
  it('imports every Markdown file below each path, skipping dot-directories, with title and tags from the file', async () => {
    const root = join(temp(), 'vault');
    mkdirSync(join(root, 'projects', 'deep'), { recursive: true });
    mkdirSync(join(root, '.obsidian'), { recursive: true });
    mkdirSync(join(root, 'node_modules', 'pkg'), { recursive: true });
    writeFileSync(join(root, 'inbox.md'), '# Inbox\n\n- call the plumber');
    writeFileSync(join(root, 'projects', 'deep', 'plan.markdown'), `---\ntitle: Garden plan\ntags: [garden, ${Array.from({ length: 30 }, (_, i) => `t${i}`).join(', ')}]\n---\nRaised beds this year.`);
    writeFileSync(join(root, 'projects', 'untitled.md'), 'no heading here');
    writeFileSync(join(root, '.obsidian', 'workspace.md'), 'editor state');
    writeFileSync(join(root, 'node_modules', 'pkg', 'README.md'), 'dependency docs');
    writeFileSync(join(root, 'notes.txt'), 'not markdown');
    const items = await collect(createMarkdownImporter(), [root]);
    const label = `vault-${createHash('sha1').update(resolve(root)).digest('hex').slice(0, 8)}`;
    expect(items.map((i) => i.externalId)).toEqual([`${label}/inbox.md`, `${label}/projects/deep/plan.markdown`, `${label}/projects/untitled.md`]);
    expect(items[0]).toMatchObject({ title: 'Inbox', kind: 'doc', namespace: 'shared', originClass: 'untrusted', tags: ['source:markdown'] });
    expect(items[1].title).toBe('Garden plan');
    expect(items[1].body).toBe('Raised beds this year.');
    expect(items[1].tags.slice(0, 3)).toEqual(['source:markdown', 'garden', 't0']);
    expect(items[1].tags).toHaveLength(MAX_USER_TAGS);
    expect(items[2].title).toBe('untitled');
    expect((await collect(createMarkdownImporter({ originClass: 'owner' }), [root]))[0].originClass).toBe('owner');
    expect(await collect(createMarkdownImporter(), [root], { exclude: buildExcludeMatcher(['projects']) })).toHaveLength(1);
  });
});
