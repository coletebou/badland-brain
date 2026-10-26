import { describe, expect, it } from 'vitest';

import { chunkMarkdown, estimateTokens } from './chunk.js';

const options = { chunkTokens: 50, chunkOverlap: 10, wholeNoteTokenLimit: 40 };
const line = (i: number): string => `line ${i} ${'x'.repeat(30)}`; // about 10 tokens each

describe('chunkMarkdown', () => {
  it('returns one chunk for short notes with a 1-based line span', () => {
    expect(chunkMarkdown('a\nb\nc', options)).toEqual([{ ord: 0, startLine: 1, endLine: 3, text: 'a\nb\nc' }]);
  });

  it('splits at headings and packs sections up to the budget', () => {
    const body = ['# A', line(1), line(2), '## B', line(3), line(4), line(5), '## C', line(6)].join('\n');
    const chunks = chunkMarkdown(body, options);
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks[0].startLine).toBe(1);
    expect(chunks.at(-1)?.endLine).toBe(9);
    expect(chunks.every((chunk) => estimateTokens(chunk.text) <= 60)).toBe(true);
    expect(chunks.map((chunk) => chunk.ord)).toEqual(chunks.map((_, i) => i));
    expect(chunks.map((chunk) => chunk.text).join('\n')).toContain('## C');
    for (let i = 1; i < chunks.length; i++) {
      expect(chunks[i].startLine).toBe(chunks[i - 1].endLine + 1); // sections pack without overlap
    }
  });

  it('splits an oversized section by lines with overlap and never inside a fence', () => {
    const body = ['# Big', ...Array.from({ length: 12 }, (_, i) => line(i)), '```', 'code 1', 'code 2', 'code 3', '```', line(99)].join('\n');
    const chunks = chunkMarkdown(body, options);
    expect(chunks.length).toBeGreaterThan(2);
    for (const chunk of chunks) {
      const fences = (chunk.text.match(/^```/gmu) ?? []).length;
      expect(fences % 2).toBe(0);
    }
    expect(chunks[1].startLine).toBeLessThanOrEqual(chunks[0].endLine); // overlap carried at least one line
    expect(chunks.at(-1)?.endLine).toBe(19);
    expect(chunks.at(-1)?.text).toContain('line 99');
  });

  it('emits an oversized atomic unit once and never re-carries it into the next chunk', () => {
    const fence = ['```', `FENCEMARKER ${'y'.repeat(80)}`, '```'];
    const body = [line(1), line(2), ...fence, line(3), line(4), line(5)].join('\n');
    const chunks = chunkMarkdown(body, options);
    expect(chunks.filter((chunk) => chunk.text.includes('FENCEMARKER'))).toHaveLength(1);
  });

  it('closes a fence only with its own marker, so other fence lines and headings inside stay inside', () => {
    const body = ['# H', '````md', 'inside', '```', 'still inside', '# not a heading', '~~~', '````', line(1)].join('\n');
    const chunks = chunkMarkdown(body, { ...options, wholeNoteTokenLimit: 1 });
    expect(chunks.some((chunk) => chunk.text.startsWith('# not a heading'))).toBe(false);
    const fenced = chunks.find((chunk) => chunk.text.includes('````md'));
    expect(fenced?.text).toContain('still inside');
    expect(fenced?.text).toContain('~~~');
    expect(fenced?.text).toContain('\n````');
  });

  it('keeps a fence that is larger than the budget whole', () => {
    const fenced = ['```', ...Array.from({ length: 8 }, (_, i) => line(i)), '```'].join('\n');
    const body = ['# H', fenced, line(50)].join('\n');
    const chunks = chunkMarkdown(body, options);
    const withFence = chunks.find((chunk) => chunk.text.includes('```'));
    expect(withFence?.text.match(/^```/gmu)).toHaveLength(2);
  });
});
