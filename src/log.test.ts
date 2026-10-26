import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import { createLogger, reasonOf } from './log.js';
import { VERSION } from './version.js';

describe('logger', () => {
  it('writes one JSON line per event at or above its level', () => {
    const lines: string[] = [];
    const logger = createLogger('warn', (line) => lines.push(line));
    logger.info('quiet');
    logger.warn('loud', { n: 1 });
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0])).toMatchObject({ level: 'warn', msg: 'loud', n: 1 });
    expect(reasonOf(new Error('a\n  b'))).toBe('a b');
  });

  it('keeps VERSION equal to the package version', () => {
    expect(VERSION).toBe((JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { version: string }).version);
  });
});
