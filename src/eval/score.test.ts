import { describe, expect, it } from 'vitest';

import { type GoldenQuestion, renderTable, scoreQuestion, summarize } from './score.js';

const recall: GoldenQuestion = { id: 'q1', question: 'port?', kind: 'recall', expectSlugPrefixes: ['ports-'], forbidSlugPrefixes: [] };
const abstain: GoldenQuestion = { id: 'q2', question: 'moon?', kind: 'abstain', expectSlugPrefixes: [], forbidSlugPrefixes: [] };
const revoked: GoldenQuestion = { id: 'q3', question: 'old port?', kind: 'revoked', expectSlugPrefixes: ['ports-v2-'], forbidSlugPrefixes: ['ports-v1-'] };

describe('eval scoring', () => {
  it('scores recall by rank, abstention by threshold, and revocation by leak', () => {
    const r = scoreQuestion(recall, [{ slug: 'pnpm-a', score: 0.9 }, { slug: 'ports-b', score: 0.8 }], 0.2);
    expect(r).toMatchObject({ hit: true, rank: 2, abstainedCorrectly: null, leaked: false, top: { slug: 'pnpm-a', similarity: null, textRank: null } });
    const a = scoreQuestion(abstain, [{ slug: 'x', score: 0.5, similarity: 0.1, textRank: null }], 0.35);
    expect(a.abstainedCorrectly).toBe(true);
    expect(scoreQuestion(abstain, [{ slug: 'x', score: 0.5, similarity: 0.6, textRank: null }], 0.35).abstainedCorrectly).toBe(false);
    expect(scoreQuestion(abstain, [{ slug: 'x', score: 0.5, similarity: 0.1, textRank: 1 }], 0.35).abstainedCorrectly).toBe(false);
    expect(scoreQuestion(abstain, [], 0.2).abstainedCorrectly).toBe(true);
    const v = scoreQuestion(revoked, [{ slug: 'ports-v1-a', score: 0.9 }], 0.2);
    expect(v).toMatchObject({ leaked: true, hit: false, missedCurrent: true });
    expect(scoreQuestion(revoked, [], 0.2)).toMatchObject({ leaked: false, hit: false, missedCurrent: true });
    expect(scoreQuestion(revoked, [{ slug: 'ports-v2-a', score: 0.9 }], 0.2)).toMatchObject({ leaked: false, hit: true, missedCurrent: false });
    expect(scoreQuestion(recall, Array.from({ length: 7 }, (_, i) => ({ slug: i === 6 ? 'ports-late' : `x${i}`, score: 1 })), 0.2).hit).toBe(false);
  });

  it('summarizes', () => {
    const outcomes = [
      scoreQuestion(recall, [{ slug: 'pnpm-a', score: 0.9 }, { slug: 'ports-b', score: 0.8 }], 0.2),
      scoreQuestion(abstain, [{ slug: 'x', score: 0.1, similarity: 0.05, textRank: null }], 0.35),
      scoreQuestion(revoked, [{ slug: 'ports-v1-a', score: 0.9 }], 0.2),
    ];
    const summary = summarize(outcomes);
    expect(summary).toEqual({ recallAt5: 1, mrrAt5: 0.5, abstainPrecision: 1, revocationLeaks: 1, revocationMisses: 1, total: 3 });
    expect(renderTable(outcomes, summary)).toContain('LEAK');
    expect(renderTable([scoreQuestion(revoked, [], 0.2)], summarize([scoreQuestion(revoked, [], 0.2)]))).toContain('MISS');
    expect(summarize([])).toEqual({ recallAt5: 0, mrrAt5: 0, abstainPrecision: 1, revocationLeaks: 0, revocationMisses: 0, total: 0 });
  });
});
