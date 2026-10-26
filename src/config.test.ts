import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { loadServerConfig } from './config.js';

describe('loadServerConfig', () => {
  it('defaults to loopback, a data directory, and no quota', () => {
    const config = loadServerConfig({ BRAIN_DATA_DIR: '/data' });
    expect(config).toMatchObject({
      host: '127.0.0.1', port: 8270, mongoUri: 'mongodb://127.0.0.1:27017/badland-brain', keysFile: join('/data', 'keys.json'),
      inlineKeys: undefined, rateLimitPerMinute: 240, writeRateLimitPerMinute: 60, agentQuota: null, logLevel: 'info',
    });
    expect(config.brain.dbPath).toBe(join('/data', 'brain.sqlite'));
  });

  it('reads every override and names a bad variable without its value', () => {
    const config = loadServerConfig({
      BRAIN_HOST: '0.0.0.0', BRAIN_PORT: '9000', BRAIN_MONGODB_URI: 'mongodb://db:27017/b', BRAIN_KEYS_FILE: '/run/keys.json', BRAIN_KEYS: '[]',
      BRAIN_RATE_LIMIT_PER_MINUTE: '10', BRAIN_WRITE_RATE_LIMIT_PER_MINUTE: '2', BRAIN_AGENT_MAX_ENTRIES: '500', BRAIN_LOG_LEVEL: 'WARN',
    });
    expect(config).toMatchObject({ host: '0.0.0.0', port: 9000, mongoUri: 'mongodb://db:27017/b', keysFile: '/run/keys.json', inlineKeys: '[]', rateLimitPerMinute: 10, writeRateLimitPerMinute: 2, logLevel: 'warn' });
    expect(config.agentQuota).toEqual({ maxEntries: 500, maxBytes: Number.MAX_SAFE_INTEGER });
    expect(() => loadServerConfig({ BRAIN_PORT: '70000' })).toThrow('BRAIN_PORT must be a port number');
    expect(() => loadServerConfig({ BRAIN_RATE_LIMIT_PER_MINUTE: 'lots' })).toThrow('BRAIN_RATE_LIMIT_PER_MINUTE must be a positive integer');
    expect(loadServerConfig({ BRAIN_LOG_LEVEL: 'chatty' }).logLevel).toBe('info');
  });
});
