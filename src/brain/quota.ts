/**
 * An optional storage bound on the entries agents write. Every version an agent wrote counts, superseded and forgotten ones
 * included: both stay stored as history, so forgetting cannot be used to cycle unbounded storage. Owner and system
 * entries never count; imports that carry the agent origin do.
 */
import { BrainEntry } from './model.js';
import { BrainInputError, type BrainStore } from './store.js';

export interface BrainWriteQuota { maxEntries: number; maxBytes: number }
export interface BrainWriteUsage { entries: number; bytes: number }

export async function agentWriteUsage(): Promise<BrainWriteUsage> {
  const [row] = await BrainEntry.aggregate<BrainWriteUsage>([
    { $match: { originClass: 'agent' } },
    { $group: { _id: null, entries: { $sum: 1 }, bytes: { $sum: { $add: [{ $strLenBytes: '$title' }, { $strLenBytes: '$body' }] } } } },
  ]);
  return { entries: row?.entries ?? 0, bytes: row?.bytes ?? 0 };
}

async function assertQuota(quota: BrainWriteQuota, incomingBytes: number): Promise<void> {
  const usage = await agentWriteUsage();
  if (usage.entries + 1 > quota.maxEntries || usage.bytes + incomingBytes > quota.maxBytes) {
    throw new BrainInputError(
      `The storage the brain allows agents is full (${quota.maxEntries} entries or ${quota.maxBytes} bytes, history included). `
      + 'Nothing was saved; ask the owner to raise the limit.',
    );
  }
}

const bytesOf = (...parts: Array<string | undefined>): number => parts.reduce((sum, part) => sum + Buffer.byteLength(part ?? ''), 0);

/**
 * The same store with `note` and `supersede` refusing agent writes past the quota. The check is a pre-write read, so
 * concurrent writes may overshoot by the request rate limit at most; the cap is a storage bound, not an invariant.
 */
export function withAgentWriteQuota(store: BrainStore, quota: BrainWriteQuota): BrainStore {
  const limited = Object.create(store) as BrainStore;
  limited.note = async (actor, input, visibility) => {
    if (actor.originClass === 'agent') {
      await assertQuota(quota, bytesOf(input.title, input.body));
    }
    return store.note(actor, input, visibility);
  };
  limited.supersede = async (actor, slug, input, visibility) => {
    if (actor.originClass === 'agent') {
      await assertQuota(quota, bytesOf(input.title, input.body));
    }
    return store.supersede(actor, slug, input, visibility);
  };
  return limited;
}
