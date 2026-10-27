import { readFile, readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';

import type { BrainKind } from '../brain/model.js';
import { type ImportItem, type Importer, repoNamespace, tagOf } from './framework.js';
import { parseFrontmatter } from './frontmatter.js';
import { repoOfMemoryDir } from './repos.js';

const SKIP_FILES = new Set(['MEMORY.md']);
const SKIP_PREFIXES = ['DREAMS'];
const SKIP_DIRS = new Set(['.analysis', '.dreams']);

const kindOf = (type: string | undefined): BrainKind => (type === 'reference' ? 'reference' : 'memory');

/**
 * Claude Code's file-based memory: one item per topic file in each memory directory given. The index (`MEMORY.md`)
 * and diary files are skipped; frontmatter becomes the title, kind and tags; the directory names the repo namespace.
 */
export const claudeMemoryImporter: Importer = {
  source: 'claude-memory',
  async *scan({ paths, exclude, repoRoots }): AsyncIterable<ImportItem> {
    for (const dir of paths) {
      const repo = repoOfMemoryDir(dir, repoRoots);
      if (exclude(repo) || exclude(dir)) {
        continue;
      }
      let names: string[];
      try {
        names = await readdir(dir);
      } catch {
        continue;
      }
      for (const name of names.sort()) {
        if (!name.endsWith('.md') || SKIP_FILES.has(name) || SKIP_PREFIXES.some((p) => name.startsWith(p)) || SKIP_DIRS.has(name)) {
          continue;
        }
        const path = join(dir, name);
        const info = await stat(path);
        if (!info.isFile()) {
          continue;
        }
        const { data, body } = parseFrontmatter(await readFile(path, 'utf8'));
        const type = data['metadata.type'] ?? data.type;
        const description = data.description ? `> ${data.description}\n\n` : '';
        yield {
          externalId: `${repo}/${name}`,
          title: (data.name ?? name.replace(/\.md$/u, '')).slice(0, 200),
          body: `${description}${body}`,
          kind: kindOf(type),
          tags: ['source:claude-memory', tagOf(`repo:${repo}`), ...(type ? [tagOf(`type:${type}`)] : [])],
          namespace: repoNamespace(repo),
          originClass: 'agent',
          capturedAt: info.mtime,
          path,
        };
      }
    }
  },
};
