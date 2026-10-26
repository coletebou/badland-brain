import { type BrainConfig, loadBrainConfig } from '../brain/config.js';
import type { IndexIdentity } from '../brain/index/schema.js';

/** The brain settings most tests use: a 32-dimension fake embedder and a data directory nobody writes to. */
export const testConfig = (env: NodeJS.ProcessEnv = {}): BrainConfig =>
  loadBrainConfig({ BRAIN_EMBED_PROVIDER: 'fake', BRAIN_EMBED_DIMS: '32', BRAIN_DATA_DIR: '/nonexistent/badland-brain-test', ...env });

export const testIdentity = (config: BrainConfig = testConfig()): IndexIdentity => ({
  embedModel: 'fake', embedDims: config.embedDims, chunkTokens: config.chunkTokens, chunkOverlap: config.chunkOverlap, ftsTokenizer: config.ftsTokenizer,
});
