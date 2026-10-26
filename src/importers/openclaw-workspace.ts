import { readFile, readdir, stat } from 'node:fs/promises';
import { basename, join } from 'node:path';

import type { BrainKind } from '../brain/model.js';
import type { ImportItem, Importer } from './framework.js';

const CC_SYNC_OPEN = '<!-- cc-sync -->';
const CC_SYNC_CLOSE = '<!-- /cc-sync -->';
const DAILY = /^(\d{4}-\d{2}-\d{2})/u;

/**
 * Remove the blocks that mirror Claude Code memory into a daily note (that content is imported from its own source,
 * claude-memory). A mirror tool closes each block with `<!-- /cc-sync -->`, and the mirrored files carry their own
 * `## ` headings, so only the close marker ends a block. A block left unclosed (written before the close marker
 * existed) runs to the next `## ` heading other than its own `## Claude Code Context`, or to the end.
 */
export function stripCcSync(text: string): string {
  const lines = text.split('\n');
  const out: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].trim() !== CC_SYNC_OPEN) {
      out.push(lines[i]);
      continue;
    }
    // The block's own close marker comes before any later block opens.
    let end = i + 1;
    while (end < lines.length && lines[end].trim() !== CC_SYNC_CLOSE && lines[end].trim() !== CC_SYNC_OPEN) {
      end++;
    }
    if (end < lines.length && lines[end].trim() === CC_SYNC_CLOSE) {
      i = end;
      continue;
    }
    // Unclosed: the heading rule, bounded by the next block's open marker, which is handled as its own block.
    let next = i + 1;
    while (next < end && !(lines[next].startsWith('## ') && !lines[next].startsWith('## Claude Code Context'))) {
      next++;
    }
    i = next - 1;
  }
  return out.join('\n').replace(/\n{3,}/gu, '\n\n').trim();
}

async function listMarkdown(dir: string): Promise<string[]> {
  try {
    return (await readdir(dir)).filter((name) => name.endsWith('.md')).sort();
  } catch {
    return [];
  }
}

/**
 * A local copy of one OpenClaw agent workspace (`MEMORY.md` + `memory/`): the long-term memory file, the daily notes
 * and the topic files. The directory's name is the agent id and names the `agent:<id>` namespace.
 */
export const openclawWorkspaceImporter: Importer = {
  source: 'openclaw-workspace',
  async *scan({ paths, exclude }): AsyncIterable<ImportItem> {
    for (const dir of paths) {
      const agent = basename(dir);
      if (exclude(dir)) {
        continue;
      }
      const namespace = `agent:${agent.toLowerCase().replace(/[^a-z0-9@.-]+/gu, '-').replace(/^[^a-z0-9]+/u, '').slice(0, 64) || 'workspace'}`;
      const tags = ['source:openclaw', `agent:${agent}`.slice(0, 50)];
      const emit = (relative: string, title: string, body: string, kind: BrainKind, capturedAt?: Date): ImportItem =>
        ({ externalId: `${agent}/${relative}`, title: title.slice(0, 200), body, kind, tags, namespace, originClass: 'agent', capturedAt, path: join(dir, relative) });

      try {
        const memory = await readFile(join(dir, 'MEMORY.md'), 'utf8');
        const info = await stat(join(dir, 'MEMORY.md'));
        yield emit('MEMORY.md', `${agent} long-term memory`, memory, 'reference', info.mtime);
      } catch {
        // No long-term memory file in this workspace.
      }

      for (const name of await listMarkdown(join(dir, 'memory'))) {
        const path = join(dir, 'memory', name);
        const text = stripCcSync(await readFile(path, 'utf8'));
        if (!text) {
          continue; // nothing but a mirrored block
        }
        const day = DAILY.exec(name)?.[1];
        yield emit(`memory/${name}`, `${agent} notes ${name.replace(/\.md$/u, '')}`, text, 'memory', day ? new Date(`${day}T12:00:00Z`) : undefined);
      }

      for (const name of await listMarkdown(join(dir, 'memory', 'topics'))) {
        const path = join(dir, 'memory', 'topics', name);
        const text = await readFile(path, 'utf8');
        const title = /^# (.+)$/mu.exec(text)?.[1] ?? name.replace(/\.md$/u, '');
        yield emit(`memory/topics/${name}`, title, text, 'reference', (await stat(path)).mtime);
      }
    }
  },
};
