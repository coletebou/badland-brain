import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { BRAIN_SCOPE_OF_KIND, defaultDataDir, loadBrainConfig } from './config.js';

describe('loadBrainConfig', () => {
  it('has the release identity defaults', () => {
    const config = loadBrainConfig({ BRAIN_DATA_DIR: '/data' });
    expect(config).toMatchObject({
      embedProvider: 'gemini',
      embedModel: 'gemini-embedding-2',
      embedDims: 1536,
      chunkTokens: 600,
      chunkOverlap: 72,
      wholeNoteTokenLimit: 800,
      rrfK: 60,
      candidatesPerLeg: 80,
      mmrLambda: 0.7,
      halfLifeDays: 30,
      defaultTopK: 6,
      maxTopK: 10,
      standingTag: 'standing',
      embedBaseUrl: 'https://api.openai.com/v1',
    });
    expect(config.dbPath).toBe(join('/data', 'brain.sqlite'));
    expect(config.ftsTokenizer).toBe("unicode61 remove_diacritics 2 tokenchars '_-'");
  });

  it('places data under BRAIN_DATA_DIR, else XDG_DATA_HOME, else ~/.local/share', () => {
    expect(defaultDataDir({ BRAIN_DATA_DIR: ' /srv/brain ' })).toBe('/srv/brain');
    expect(defaultDataDir({ XDG_DATA_HOME: '/xdg' })).toBe(join('/xdg', 'badland-brain'));
    expect(defaultDataDir({})).toMatch(/\.local[\\/]share[\\/]badland-brain$/u);
  });

  it('reads overrides and rejects bad values', () => {
    expect(loadBrainConfig({ BRAIN_DB_PATH: '/tmp/x.sqlite', BRAIN_EMBED_DIMS: '768', BRAIN_EMBED_MODEL: 'other' }))
      .toMatchObject({ dbPath: '/tmp/x.sqlite', embedDims: 768, embedModel: 'other' });
    expect(() => loadBrainConfig({ BRAIN_EMBED_DIMS: '4' })).toThrow(/BRAIN_EMBED_DIMS/u);
    expect(() => loadBrainConfig({ BRAIN_EMBED_DIMS: '9000' })).toThrow(/BRAIN_EMBED_DIMS/u);
    expect(() => loadBrainConfig({ BRAIN_EMBED_DIMS: 'abc' })).toThrow(/BRAIN_EMBED_DIMS/u);
    expect(() => loadBrainConfig({ BRAIN_EMBED_PROVIDER: 'cohere' })).toThrow(/BRAIN_EMBED_PROVIDER/u);
    expect(() => loadBrainConfig({ BRAIN_EMBED_BATCH_SIZE: '0' })).toThrow(/BRAIN_EMBED_BATCH_SIZE/u);
    expect(loadBrainConfig({ BRAIN_DB_PATH: '   ', BRAIN_DATA_DIR: '/d' }).dbPath).toBe(join('/d', 'brain.sqlite'));
  });

  it('defaults the model and size per provider', () => {
    expect(loadBrainConfig({ BRAIN_EMBED_PROVIDER: 'openai' })).toMatchObject({ embedModel: 'text-embedding-3-small', embedDims: 1536 });
    expect(loadBrainConfig({ BRAIN_EMBED_PROVIDER: 'FAKE', BRAIN_EMBED_MODEL: 'ignored' })).toMatchObject({ embedProvider: 'fake', embedModel: 'fake', embedDims: 256 });
    expect(loadBrainConfig({ BRAIN_EMBED_PROVIDER: 'openai', BRAIN_EMBED_BASE_URL: 'http://127.0.0.1:11434/v1/' }).embedBaseUrl).toBe('http://127.0.0.1:11434/v1');
  });

  it('maps kinds to scopes', () => {
    expect(BRAIN_SCOPE_OF_KIND.memory).toBe('core');
    expect(BRAIN_SCOPE_OF_KIND.doc).toBe('core');
    expect(BRAIN_SCOPE_OF_KIND.photo).toBe('media');
    expect(BRAIN_SCOPE_OF_KIND.mail).toBe('comms');
    expect(BRAIN_SCOPE_OF_KIND.chat).toBe('comms');
  });
});
