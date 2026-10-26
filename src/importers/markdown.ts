import { readFile, readdir, stat } from 'node:fs/promises';
import { basename, join, relative, sep } from 'node:path';

import { MAX_USER_TAGS } from '../brain/model.js';
import { MAX_TAG_CHARS } from '../brain/store-views.js';
import type { ImportItem, Importer } from './framework.js';
import { frontmatterList, parseFrontmatter } from './frontmatter.js';

/** Files larger than this are skipped: a notes folder holds notes, not exports or logs. */
export const MAX_MARKDOWN_BYTES = 5 * 1024 * 1024;
const SKIP_DIRS = new Set(['node_modules']);

async function* walk(dir: string): AsyncIterable<string> {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (entry.name.startsWith('.') || SKIP_DIRS.has(entry.name)) {
      continue;
    }
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      yield* walk(path);
    } else if (entry.isFile() && /\.(md|markdown)$/iu.test(entry.name)) {
      yield path;
    }
  }
}

/** Tags from frontmatter, cut to the brain's limits, behind the source tag. */
function tagsOf(raw: string | undefined): string[] {
  const kept = new Set<string>(['source:markdown']);
  for (const tag of frontmatterList(raw)) {
    if (kept.size >= MAX_USER_TAGS) {
      break;
    }
    const clean = tag.slice(0, MAX_TAG_CHARS).trim();
    if (clean.length > 0) {
      kept.add(clean);
    }
  }
  return [...kept];
}

/**
 * Any folder of Markdown notes (a notes app's vault, a docs directory), recursively, skipping dot-directories and
 * node_modules. Each file is one `doc` entry: the title from frontmatter `title`, else the first `# ` heading, else
 * the file name; tags from frontmatter `tags`. The origin class is the caller's choice and defaults to `untrusted`,
 * since a folder may hold text someone else wrote: pass `owner` for your own notes.
 */
export function createMarkdownImporter(options: { originClass?: ImportItem['originClass'] } = {}): Importer {
  const originClass = options.originClass ?? 'untrusted';
  return {
    source: 'markdown',
    async *scan({ paths, exclude }): AsyncIterable<ImportItem> {
      for (const root of paths) {
        const label = basename(root) || 'notes';
        for await (const path of walk(root)) {
          if (exclude(path)) {
            continue;
          }
          const info = await stat(path);
          if (info.size > MAX_MARKDOWN_BYTES) {
            continue;
          }
          const { data, body } = parseFrontmatter(await readFile(path, 'utf8'));
          const name = basename(path).replace(/\.(md|markdown)$/iu, '');
          const title = data.title ?? /^# (.+)$/mu.exec(body)?.[1]?.trim() ?? name;
          yield {
            externalId: `${label}/${relative(root, path).split(sep).join('/')}`,
            title: title.slice(0, 200),
            body,
            kind: 'doc',
            tags: tagsOf(data.tags),
            namespace: 'shared',
            originClass,
            capturedAt: info.mtime,
            path,
          };
        }
      }
    },
  };
}
