import { estimateTokens } from './chunk.js';
import type { BrainConfig } from './config.js';
import { BrainEntry } from './model.js';
import { BrainInputError, type Visibility } from './store-views.js';

export interface BrainContextBlock {
  standing: Array<{ slug: string; title: string; body: string; importance: number }>;
  recentDecisions: Array<{ slug: string; title: string; validFrom: string }>;
  namespaces: string[];
  tokens: number;
  truncated: boolean;
}

const RECENT_DECISIONS = 10;

/**
 * The namespaces a standing-facts block covers: `shared` plus the one the caller asks for, so a repo's or an agent's
 * own standing facts never auto-load into unrelated sessions. A confined key sees only its own namespaces; when it
 * cannot see `shared` and asks for nothing, the block covers every namespace it may see.
 */
export function contextNamespaces(requested: string | undefined, visibility: Visibility = {}): string[] {
  const wanted = requested && requested !== 'shared' ? ['shared', requested] : ['shared'];
  const allowed = visibility.namespaces;
  if (!allowed) {
    return wanted;
  }
  if (requested && !allowed.includes(requested)) {
    throw new BrainInputError(`namespace ${requested} is outside this key's namespaces`);
  }
  const visible = wanted.filter((namespace) => allowed.includes(namespace));
  return visible.length > 0 ? visible : [...allowed];
}

/**
 * The standing-facts block: curated entries tagged as standing, packed into a token budget, plus the most recent
 * decisions. A plain read, no retrieval. Untrusted entries stay searchable with their provenance but never auto-load
 * into a session.
 */
export async function buildContext(namespaces: readonly string[], config: BrainConfig): Promise<BrainContextBlock> {
  const now = new Date();
  const standingDocs = await BrainEntry.find({
    tier: 'curated',
    originClass: { $ne: 'untrusted' },
    tags: config.standingTag,
    forgotten: { $exists: false },
    $or: [{ invalidAt: { $exists: false } }, { invalidAt: { $gt: now } }],
    validFrom: { $lte: now },
    namespace: { $in: namespaces },
  }).sort({ importance: -1, updatedAt: -1 }).select('slug title body importance');

  const standing: BrainContextBlock['standing'] = [];
  let tokens = 0;
  let truncated = false;
  for (const doc of standingDocs) {
    const cost = estimateTokens(doc.body) + estimateTokens(doc.title);
    if (tokens + cost <= config.contextTokenBudget) {
      standing.push({ slug: doc.slug, title: doc.title, body: doc.body, importance: doc.importance });
      tokens += cost;
      continue;
    }
    const remaining = config.contextTokenBudget - tokens - estimateTokens(doc.title);
    if (remaining > 40) {
      standing.push({ slug: doc.slug, title: doc.title, body: `${doc.body.slice(0, remaining * 4)}…`, importance: doc.importance });
      tokens = config.contextTokenBudget;
    }
    truncated = true;
    break;
  }

  const decisions = await BrainEntry.find({
    kind: 'decision',
    originClass: { $ne: 'untrusted' },
    forgotten: { $exists: false },
    $or: [{ invalidAt: { $exists: false } }, { invalidAt: { $gt: now } }],
    validFrom: { $lte: now },
    namespace: { $in: namespaces },
  }).sort({ validFrom: -1 }).limit(RECENT_DECISIONS).select('slug title validFrom');

  return {
    standing,
    recentDecisions: decisions.map((doc) => ({ slug: doc.slug, title: doc.title, validFrom: doc.validFrom.toISOString() })),
    namespaces: [...namespaces],
    tokens,
    truncated,
  };
}
