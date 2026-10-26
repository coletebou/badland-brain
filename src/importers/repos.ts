import { homedir } from 'node:os';
import { basename, posix, resolve, sep } from 'node:path';

/** Claude Code names a project directory after its working directory, every character but letters and digits as `-`. */
export const encodeProjectPath = (path: string): string => resolve(path).replace(/[^A-Za-z0-9]/gu, '-');

/** A sibling worktree directory named `<repo>-<YYYYMMDD>…` belongs to `<repo>`. */
const DATED_WORKTREE = /-\d{8}(?:[^\d].*)?$/u;
/** A nested worktree (`<repo>/.claude/worktrees/<name>` or `<repo>/.worktrees/<name>`) belongs to the repo holding it. */
const NESTED_WORKTREE = /^(.*?)[\\/]\.(?:claude[\\/])?worktrees(?:[\\/]|$)/u;
const ENCODED_NESTED_WORKTREE = /--(?:claude-)?worktrees(?:-.*)?$/u;

const longestFirst = (roots: readonly string[]): string[] => [...new Set(roots.map((root) => resolve(root)))].sort((a, b) => b.length - a.length);

/**
 * The repository a path belongs to: the first directory below the longest repo root that holds it, else the path's
 * own last directory. Null for an empty or root path.
 */
export function repoOfPath(path: string, roots: readonly string[]): string | null {
  const absolute = path.startsWith('/') ? posix.normalize(path) : resolve(path);
  const candidate = NESTED_WORKTREE.exec(absolute)?.[1] ?? absolute;
  for (const root of longestFirst(roots)) {
    if (candidate.startsWith(`${root}${sep}`) || candidate.startsWith(`${root}/`)) {
      const first = candidate.slice(root.length + 1).split(/[\\/]/u)[0];
      return first ? first.replace(DATED_WORKTREE, '') : null;
    }
  }
  const last = basename(candidate);
  return last ? last.replace(DATED_WORKTREE, '') : null;
}

/**
 * The repository a Claude Code memory directory belongs to. A memory home named after its repo (`…/memory/<repo>`)
 * names it directly; a project directory (`~/.claude/projects/<encoded working directory>/memory`) is decoded against
 * the repo roots, longest first, then the home directory, so `-home-me-src-my-repo` with the root `~/src` is `my-repo`.
 */
export function repoOfMemoryDir(dir: string, roots: readonly string[], home: string = homedir()): string {
  const name = basename(dir) === 'memory' ? basename(resolve(dir, '..')) : basename(dir);
  if (!name.startsWith('-')) {
    return name.toLowerCase();
  }
  for (const root of [...longestFirst(roots), resolve(home)]) {
    const prefix = encodeProjectPath(root);
    if (name === prefix) {
      return (basename(root) || 'home').toLowerCase();
    }
    if (name.startsWith(`${prefix}-`)) {
      return name.slice(prefix.length + 1).replace(ENCODED_NESTED_WORKTREE, '').replace(DATED_WORKTREE, '').toLowerCase();
    }
  }
  return name.replace(/^-+/u, '').toLowerCase();
}
