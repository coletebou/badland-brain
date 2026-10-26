/**
 * Minimal YAML-subset frontmatter: `key: value` lines between `---` fences, with one level of nesting flattened as
 * `parent.child`, and `- item` lines under a key joined into a comma-separated value. Enough for agent memory files
 * (`name`, `description`, `type`, `metadata.type`) and simple note metadata (`title`, `tags`).
 */
export function parseFrontmatter(text: string): { data: Record<string, string>; body: string } {
  const lines = text.split('\n');
  if (lines[0]?.trim() !== '---') {
    return { data: {}, body: text };
  }
  const end = lines.findIndex((line, i) => i > 0 && line.trim() === '---');
  if (end === -1) {
    return { data: {}, body: text };
  }
  const data: Record<string, string> = {};
  let parent: string | null = null;
  const unquote = (value: string): string => value.trim().replace(/^["']|["']$/gu, '');
  for (const raw of lines.slice(1, end)) {
    const item = /^\s+-\s+(.*)$/u.exec(raw);
    if (item && parent) {
      const value = unquote(item[1]);
      data[parent] = data[parent] ? `${data[parent]}, ${value}` : value;
      continue;
    }
    const match = /^(\s*)([A-Za-z0-9_-]+):\s*(.*)$/u.exec(raw);
    if (!match) {
      continue;
    }
    const [, indent, key, value] = match;
    const clean = unquote(value);
    if (indent.length === 0) {
      parent = clean.length === 0 ? key : null;
      if (clean.length > 0) {
        data[key] = clean;
      }
      continue;
    }
    if (parent) {
      data[`${parent}.${key}`] = clean;
    }
  }
  return { data, body: lines.slice(end + 1).join('\n').replace(/^\n+/u, '') };
}

/** A frontmatter list value, `[a, b]` or `a, b`, as trimmed strings. */
export const frontmatterList = (value: string | undefined): string[] =>
  (value ?? '').replace(/^\[|\]$/gu, '').split(',').map((part) => part.trim().replace(/^["']|["']$/gu, '')).filter((part) => part.length > 0);
