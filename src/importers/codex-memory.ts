import { createHash } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';

import { type ImportItem, type Importer, repoNamespace, tagOf } from './framework.js';
import { repoOfPath } from './repos.js';

const cwdOf = (text: string): string | undefined => /cwd[=:]\s*([^\s;,)]+)/u.exec(text)?.[1];

/** `cwd=/home/me/src/my-repo` or `cwd: /home/me/src/my-repo` → `repo:my-repo`; no working directory → shared. */
export function namespaceOfCwd(text: string, repoRoots: readonly string[] = []): string {
  const cwd = cwdOf(text);
  const repo = cwd ? repoOfPath(cwd, repoRoots) : null;
  return repo ? repoNamespace(repo) : 'shared';
}

/** Split Codex's consolidated MEMORY.md into task groups. */
export function splitTaskGroups(memory: string): Array<{ title: string; body: string }> {
  const groups: Array<{ title: string; body: string }> = [];
  let current: { title: string; lines: string[] } | null = null;
  for (const line of memory.split('\n')) {
    const heading = /^# Task Group:\s*(.+)$/u.exec(line);
    if (heading) {
      if (current) {
        groups.push({ title: current.title, body: current.lines.join('\n').trim() });
      }
      current = { title: heading[1].trim(), lines: [] };
      continue;
    }
    current?.lines.push(line);
  }
  if (current) {
    groups.push({ title: current.title, body: current.lines.join('\n').trim() });
  }
  return groups;
}

/**
 * Codex's own distillate in each memories directory given: task groups from MEMORY.md plus per-thread rollout
 * summaries. raw_memories.md and memory_summary.md are derived churn and are never read. Anything whose working
 * directory or namespace matches an exclusion term is dropped. A task group's identity hashes its directory with its
 * title, so two memories directories with a group of the same name keep both.
 */
export const codexMemoryImporter: Importer = {
  source: 'codex-memory',
  async *scan({ paths, exclude, repoRoots }): AsyncIterable<ImportItem> {
    for (const dir of paths) {
      if (exclude(dir)) {
        continue;
      }
      let memory: string;
      try {
        memory = await readFile(join(dir, 'MEMORY.md'), 'utf8');
      } catch {
        memory = '';
      }
      for (const group of splitTaskGroups(memory)) {
        const cwd = cwdOf(group.body);
        const namespace = namespaceOfCwd(group.body, repoRoots);
        if ((cwd && exclude(cwd)) || exclude(namespace)) {
          continue;
        }
        yield {
          externalId: `task-group:${createHash('sha1').update(`${resolve(dir)}\n${group.title}`).digest('hex').slice(0, 12)}`,
          title: group.title.slice(0, 200),
          body: group.body,
          kind: 'memory',
          tags: ['source:codex-memory', ...(namespace === 'shared' ? [] : [tagOf(namespace)])],
          namespace,
          originClass: 'agent',
          path: cwd,
        };
      }
      let summaries: string[];
      try {
        summaries = (await readdir(join(dir, 'rollout_summaries'))).filter((name) => name.endsWith('.md')).sort();
      } catch {
        summaries = [];
      }
      for (const name of summaries) {
        const path = join(dir, 'rollout_summaries', name);
        const text = await readFile(path, 'utf8');
        const cwd = cwdOf(text);
        const namespace = namespaceOfCwd(text, repoRoots);
        if ((cwd && exclude(cwd)) || exclude(namespace)) {
          continue;
        }
        const title = /^# (.+)$/mu.exec(text)?.[1] ?? name.replace(/\.md$/u, '');
        const updated = /^updated_at:\s*(\S+)/mu.exec(text)?.[1];
        yield {
          externalId: `rollout:${name}`,
          title: title.slice(0, 200),
          body: text,
          kind: 'handoff',
          tags: ['source:codex-memory', 'kind:rollout', ...(namespace === 'shared' ? [] : [tagOf(namespace)])],
          namespace,
          originClass: 'agent',
          capturedAt: updated ? new Date(updated) : undefined,
          path: cwd,
        };
      }
    }
  },
};
