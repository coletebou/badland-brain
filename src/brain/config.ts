import { homedir } from 'node:os';
import { join } from 'node:path';

import type { BrainKind } from './model.js';

/** Partition of the vector index. Default searches stay inside `core`. */
export type BrainScope = 'core' | 'comms' | 'media';

export const BRAIN_SCOPE_OF_KIND: Record<BrainKind, BrainScope> = {
  memory: 'core',
  decision: 'core',
  handoff: 'core',
  doc: 'core',
  reference: 'core',
  message: 'comms',
  mail: 'comms',
  chat: 'comms',
  photo: 'media',
};

export const EMBED_PROVIDERS = ['gemini', 'openai', 'fake'] as const;
export type EmbedProvider = (typeof EMBED_PROVIDERS)[number];

const DEFAULT_MODEL: Record<EmbedProvider, string> = {
  gemini: 'gemini-embedding-2',
  openai: 'text-embedding-3-small',
  fake: 'fake',
};
const DEFAULT_DIMS: Record<EmbedProvider, number> = { gemini: 1536, openai: 1536, fake: 256 };

export interface BrainConfig {
  dataDir: string;
  dbPath: string;
  embedProvider: EmbedProvider;
  embedModel: string;
  embedDims: number;
  /** OpenAI-compatible providers only: the API base, e.g. a local server's `/v1`. */
  embedBaseUrl: string;
  embedBatchSize: number;
  chunkTokens: number;
  chunkOverlap: number;
  wholeNoteTokenLimit: number;
  ftsTokenizer: string;
  rrfK: number;
  candidatesPerLeg: number;
  mmrLambda: number;
  halfLifeDays: number;
  defaultTopK: number;
  maxTopK: number;
  snippetChars: number;
  contextTokenBudget: number;
  standingTag: string;
}

const trimmed = (value: string | undefined): string | undefined => {
  const out = value?.trim();
  return out && out.length > 0 ? out : undefined;
};

/** `$BRAIN_DATA_DIR`, else `$XDG_DATA_HOME/badland-brain`, else `~/.local/share/badland-brain`. */
export function defaultDataDir(env: NodeJS.ProcessEnv = process.env): string {
  return trimmed(env.BRAIN_DATA_DIR) ?? join(trimmed(env.XDG_DATA_HOME) ?? join(homedir(), '.local', 'share'), 'badland-brain');
}

/**
 * Validate every brain setting at startup. The embedding identity fields (provider model, dimensions, chunking,
 * tokenizer) are recorded in the index; changing any of them marks the index stale until a reindex runs.
 */
export function loadBrainConfig(env: NodeJS.ProcessEnv = process.env): BrainConfig {
  const provider = (trimmed(env.BRAIN_EMBED_PROVIDER) ?? 'gemini').toLowerCase();
  if (!(EMBED_PROVIDERS as readonly string[]).includes(provider)) {
    throw new Error(`BRAIN_EMBED_PROVIDER must be one of ${EMBED_PROVIDERS.join(', ')}`);
  }
  const embedProvider = provider as EmbedProvider;
  const rawDims = trimmed(env.BRAIN_EMBED_DIMS);
  const dims = rawDims === undefined ? DEFAULT_DIMS[embedProvider] : Number(rawDims);
  // Real models use 128-4096; the floor is lower only so tests can use small fake embedders, and 8192 is sqlite-vec's ceiling.
  if (!Number.isInteger(dims) || dims < 8 || dims > 8192) {
    throw new Error('BRAIN_EMBED_DIMS must be an integer from 8 to 8192');
  }
  const batch = Number(trimmed(env.BRAIN_EMBED_BATCH_SIZE) ?? '50');
  if (!Number.isInteger(batch) || batch < 1 || batch > 250) {
    throw new Error('BRAIN_EMBED_BATCH_SIZE must be an integer from 1 to 250');
  }
  const dataDir = defaultDataDir(env);
  return Object.freeze({
    dataDir,
    dbPath: trimmed(env.BRAIN_DB_PATH) ?? join(dataDir, 'brain.sqlite'),
    embedProvider,
    embedModel: embedProvider === 'fake' ? 'fake' : trimmed(env.BRAIN_EMBED_MODEL) ?? DEFAULT_MODEL[embedProvider],
    embedDims: dims,
    embedBaseUrl: (trimmed(env.BRAIN_EMBED_BASE_URL) ?? 'https://api.openai.com/v1').replace(/\/+$/u, ''),
    embedBatchSize: batch,
    chunkTokens: 600,
    chunkOverlap: 72,
    wholeNoteTokenLimit: 800,
    ftsTokenizer: "unicode61 remove_diacritics 2 tokenchars '_-'",
    rrfK: 60,
    candidatesPerLeg: 80,
    mmrLambda: 0.7,
    halfLifeDays: 30,
    defaultTopK: 6,
    maxTopK: 10,
    snippetChars: 400,
    contextTokenBudget: 1500,
    standingTag: 'standing',
  });
}
