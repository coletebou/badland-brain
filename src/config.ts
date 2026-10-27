import { join } from 'node:path';

import { type BrainConfig, loadBrainConfig } from './brain/config.js';
import { type LogLevel, parseLogLevel } from './log.js';

export interface ServerConfig {
  host: string;
  port: number;
  mongoUri: string;
  keysFile: string;
  /** Inline key records (JSON), for deployments that keep secrets in the environment. */
  inlineKeys: string | undefined;
  rateLimitPerMinute: number;
  writeRateLimitPerMinute: number;
  /** Optional bound on what agents may store; null when unlimited. */
  agentQuota: { maxEntries: number; maxBytes: number } | null;
  logLevel: LogLevel;
  brain: BrainConfig;
}

const positiveInt = (raw: string | undefined, name: string, fallback: number): number => {
  if (raw === undefined || raw.trim() === '') {
    return fallback;
  }
  const value = Number(raw.trim());
  if (!Number.isInteger(value) || value < 1) {
    throw new Error(`${name} must be a positive integer`);
  }
  return value;
};

/**
 * A value as a dotenv file writes it: a quoted value ends at its closing quote, which an inline comment may follow;
 * an unquoted one ends before ` # comment`.
 */
export function dotenvValue(raw: string): string {
  const value = raw.trim();
  const quoted = /^(["'])(.*?)\1(?:\s+#.*)?$/u.exec(value);
  return quoted ? quoted[2] : value.replace(/\s+#.*$/u, '').trim();
}

/**
 * Every server setting, from the environment. An invalid value is an error that names the variable, never its value;
 * `.env.example` documents each one.
 */
export function loadServerConfig(env: NodeJS.ProcessEnv = process.env): ServerConfig {
  const brain = loadBrainConfig(env);
  // 0 asks the system for any free port; the listening log line names the one it got.
  const port = env.BRAIN_PORT?.trim() === '0' ? 0 : positiveInt(env.BRAIN_PORT, 'BRAIN_PORT', 8270);
  if (port > 65_535) {
    throw new Error('BRAIN_PORT must be a port number');
  }
  const maxEntries = env.BRAIN_AGENT_MAX_ENTRIES?.trim() ? positiveInt(env.BRAIN_AGENT_MAX_ENTRIES, 'BRAIN_AGENT_MAX_ENTRIES', 1) : null;
  const maxBytes = env.BRAIN_AGENT_MAX_BYTES?.trim() ? positiveInt(env.BRAIN_AGENT_MAX_BYTES, 'BRAIN_AGENT_MAX_BYTES', 1) : null;
  return {
    host: env.BRAIN_HOST?.trim() || '127.0.0.1',
    port,
    mongoUri: env.BRAIN_MONGODB_URI?.trim() || 'mongodb://127.0.0.1:27017/badland-brain',
    keysFile: env.BRAIN_KEYS_FILE?.trim() || join(brain.dataDir, 'keys.json'),
    inlineKeys: env.BRAIN_KEYS?.trim() || undefined,
    rateLimitPerMinute: positiveInt(env.BRAIN_RATE_LIMIT_PER_MINUTE, 'BRAIN_RATE_LIMIT_PER_MINUTE', 240),
    writeRateLimitPerMinute: positiveInt(env.BRAIN_WRITE_RATE_LIMIT_PER_MINUTE, 'BRAIN_WRITE_RATE_LIMIT_PER_MINUTE', 60),
    agentQuota: maxEntries === null && maxBytes === null ? null : { maxEntries: maxEntries ?? Number.MAX_SAFE_INTEGER, maxBytes: maxBytes ?? Number.MAX_SAFE_INTEGER },
    logLevel: parseLogLevel(env.BRAIN_LOG_LEVEL),
    brain,
  };
}
