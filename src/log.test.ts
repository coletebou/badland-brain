import { readFileSync } from 'node:fs';

import mongoose from 'mongoose';
import { describe, expect, it } from 'vitest';

import { BrainEntry } from './brain/model.js';
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

  it('keeps the values that database errors quote out of the reason, naming only the fields', async () => {
    const invalid = new BrainEntry({
      slug: 's', title: 'T', body: 'b', kind: 'quoted-kind-value', tier: 'episodic', namespace: 'shared', originClass: 'agent',
      authorAgent: 'a', importance: 'quoted-importance-value', validFrom: new Date(), contentHash: 'h',
    });
    const validation = await invalid.validate().then(() => null, (error: unknown) => error);
    expect((validation as Error).message).toContain('quoted-kind-value');
    expect(reasonOf(validation)).toBe('validation failed on importance, kind');

    const cast = new mongoose.Error.CastError('ObjectId', 'quoted-id-value', '_id');
    expect(cast.message).toContain('quoted-id-value');
    expect(reasonOf(cast)).toBe('cast failed on _id');

    expect(reasonOf({ code: 11000, keyPattern: { namespace: 1, contentHash: 1 }, message: 'E11000 dup key: { namespace: "shared" }' })).toBe('duplicate key on namespace, contentHash');
    expect(reasonOf({ code: 11000, message: 'E11000 dup key: { slug: "quoted" }' })).toBe('duplicate key');
    expect(reasonOf(null)).toBe('null');
    expect(reasonOf('x'.repeat(500))).toHaveLength(200);
  });

  it('keeps VERSION equal to the package version', () => {
    expect(VERSION).toBe((JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { version: string }).version);
  });
});
