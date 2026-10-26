export interface Chunk {
  ord: number;
  startLine: number;
  endLine: number;
  text: string;
}

export interface ChunkOptions {
  chunkTokens: number;
  chunkOverlap: number;
  wholeNoteTokenLimit: number;
}

/** The same cheap estimator the rest of the brain uses: four characters per token. */
export const estimateTokens = (text: string): number => Math.ceil(text.length / 4);

/** A line that starts a section; the importers cut oversize bodies at the same places. */
export const HEADING = /^#{1,3}\s/u;
const FENCE = /^ {0,3}(`{3,}|~{3,})(.*)$/u;

/** The fence marker a line opens, or null. */
export const fenceOpener = (line: string): string | null => FENCE.exec(line)?.[1] ?? null;
/** A closer repeats the opener's character at least as many times, with nothing else on the line. */
export const closesFence = (line: string, opener: string): boolean => {
  const match = FENCE.exec(line);
  return match !== null && match[1].startsWith(opener[0]) && match[1].length >= opener.length && match[2].trim() === '';
};

/** A run of lines with 1-based inclusive line numbers. */
interface Block {
  start: number;
  end: number;
  lines: string[];
  tokens: number;
}

const lineTokens = (line: string): number => estimateTokens(line) + 1;
const blockOf = (lines: string[], start: number): Block =>
  ({ start, end: start + lines.length - 1, lines, tokens: lines.reduce((n, l) => n + lineTokens(l), 0) });

/** A heading starts a block; fenced code never splits a block. */
function toBlocks(lines: string[]): Block[] {
  const blocks: Block[] = [];
  let current: string[] = [];
  let currentStart = 1;
  let fence: string | null = null;
  lines.forEach((line, i) => {
    if (!fence && HEADING.test(line) && current.length > 0) {
      blocks.push(blockOf(current, currentStart));
      current = [];
      currentStart = i + 1;
    }
    current.push(line);
    if (fence) {
      if (closesFence(line, fence)) {
        fence = null;
      }
    } else {
      fence = fenceOpener(line);
    }
  });
  if (current.length > 0) {
    blocks.push(blockOf(current, currentStart));
  }
  return blocks;
}

/** Group lines into atomic units: single lines, or a whole fenced code block. */
function toUnits(block: Block): string[][] {
  const units: string[][] = [];
  let fence: { opener: string; lines: string[] } | null = null;
  for (const line of block.lines) {
    if (fence) {
      fence.lines.push(line);
      if (closesFence(line, fence.opener)) {
        units.push(fence.lines);
        fence = null;
      }
      continue;
    }
    const opener = fenceOpener(line);
    if (opener) {
      fence = { opener, lines: [line] };
      continue;
    }
    units.push([line]);
  }
  if (fence) {
    units.push(fence.lines);
  }
  return units;
}

/** Split one oversized block by units, carrying about `chunkOverlap` tokens of trailing units forward. */
function splitBlock(block: Block, options: ChunkOptions): Block[] {
  const out: Block[] = [];
  const unitTokens = (unit: string[]): number => unit.reduce((n, l) => n + lineTokens(l), 0);
  let buffer: string[][] = [];
  let start = block.start;
  let cursor = block.start;
  for (const unit of toUnits(block)) {
    const bufferTokens = buffer.reduce((n, u) => n + unitTokens(u), 0);
    if (buffer.length > 0 && bufferTokens + unitTokens(unit) > options.chunkTokens) {
      out.push(blockOf(buffer.flat(), start));
      const carried: string[][] = [];
      let carriedTokens = 0;
      for (let i = buffer.length - 1; i >= 0; i--) {
        const unitCost = unitTokens(buffer[i]);
        // A multi-line atomic unit (a whole fence) larger than the overlap was just emitted; never carry it, or it
        // re-attaches to every following chunk. A single line still provides normal overlap.
        if (buffer[i].length > 1 && unitCost > options.chunkOverlap) {
          break;
        }
        if (carried.length > 0 && carriedTokens + unitCost > options.chunkOverlap) {
          break;
        }
        carried.unshift(buffer[i]);
        carriedTokens += unitCost;
      }
      start = cursor - carried.flat().length;
      buffer = carried;
    }
    buffer.push(unit);
    cursor += unit.length;
  }
  if (buffer.length > 0) {
    out.push(blockOf(buffer.flat(), start));
  }
  return out;
}

/**
 * Whole note when it is short; otherwise heading-aware sections packed up to
 * the token budget, with oversized sections split by line and overlapped.
 */
export function chunkMarkdown(body: string, options: ChunkOptions): Chunk[] {
  const lines = body.split('\n');
  if (estimateTokens(body) <= options.wholeNoteTokenLimit) {
    return [{ ord: 0, startLine: 1, endLine: lines.length, text: body }];
  }
  const pieces: Block[] = [];
  let accumulator: Block | null = null;
  for (const block of toBlocks(lines)) {
    if (block.tokens > options.chunkTokens) {
      if (accumulator) {
        pieces.push(accumulator);
        accumulator = null;
      }
      pieces.push(...splitBlock(block, options));
      continue;
    }
    if (accumulator && accumulator.tokens + block.tokens > options.chunkTokens) {
      pieces.push(accumulator);
      accumulator = null;
    }
    accumulator = accumulator ? blockOf([...accumulator.lines, ...block.lines], accumulator.start) : block;
  }
  if (accumulator) {
    pieces.push(accumulator);
  }
  return pieces.map((piece, ord) => ({ ord, startLine: piece.start, endLine: piece.end, text: piece.lines.join('\n') }));
}
