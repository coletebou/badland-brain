import type { BrainConfig } from '../config.js';
import { createFakeEmbedder } from './fake.js';
import { createGeminiEmbedder } from './gemini.js';
import { createOpenAiEmbedder } from './openai.js';
import type { Embedder } from './types.js';

export type { Embedder } from './types.js';
export { normalize } from './types.js';
export { createFakeEmbedder } from './fake.js';
export { createGeminiEmbedder } from './gemini.js';
export { createOpenAiEmbedder } from './openai.js';

const secret = (env: NodeJS.ProcessEnv, ...names: string[]): string | undefined =>
  names.map((name) => env[name]?.trim()).find((value): value is string => Boolean(value));

/** The configured provider's embedder. Errors name the missing setting, never a value. */
export function createEmbedder(config: BrainConfig, env: NodeJS.ProcessEnv = process.env): Embedder {
  switch (config.embedProvider) {
    case 'fake':
      return createFakeEmbedder(config.embedDims);
    case 'gemini': {
      const apiKey = secret(env, 'GEMINI_API_KEY', 'GOOGLE_API_KEY');
      if (!apiKey) {
        throw new Error('GEMINI_API_KEY (or GOOGLE_API_KEY) is not set; set it, or choose another BRAIN_EMBED_PROVIDER');
      }
      return createGeminiEmbedder({ apiKey, model: config.embedModel, dims: config.embedDims, batchSize: config.embedBatchSize });
    }
    case 'openai': {
      const apiKey = secret(env, 'BRAIN_EMBED_API_KEY', 'OPENAI_API_KEY');
      if (!apiKey && new URL(config.embedBaseUrl).hostname === 'api.openai.com') {
        throw new Error('OPENAI_API_KEY (or BRAIN_EMBED_API_KEY) is not set; set it, or point BRAIN_EMBED_BASE_URL at a server that needs none');
      }
      return createOpenAiEmbedder({ apiKey, model: config.embedModel, dims: config.embedDims, baseUrl: config.embedBaseUrl, batchSize: config.embedBatchSize });
    }
  }
}
