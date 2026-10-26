import type { BrainKind } from '../brain/model.js';

export interface GoldenQuestion {
  id: string;
  question: string;
  kind: 'recall' | 'abstain' | 'revoked';
  expectSlugPrefixes: string[];
  forbidSlugPrefixes: string[];
  kinds?: BrainKind[];
}

export interface QuestionOutcome {
  id: string;
  kind: GoldenQuestion['kind'];
  hit: boolean;
  rank: number | null;
  abstainedCorrectly: boolean | null;
  leaked: boolean;
  /** A revoked question also has to surface the current version; losing it is not a clean revocation. */
  missedCurrent: boolean;
  top: { slug: string; similarity: number | null; textRank: number | null } | null;
}

export interface EvalSummary {
  recallAt5: number;
  mrrAt5: number;
  abstainPrecision: number;
  revocationLeaks: number;
  revocationMisses: number;
  total: number;
}

const matches = (slug: string, prefixes: string[]): boolean => prefixes.some((prefix) => slug.startsWith(prefix));

export interface ScoredHit { slug: string; score: number; similarity?: number | null; textRank?: number | null }

/**
 * Score one question against the top hits (already limited to five). A search "abstains" when nothing came back, or
 * when the best hit has no keyword evidence and its semantic similarity is below the threshold. A revoked question
 * passes only when the current version is found and no forbidden historical version is, so an empty result cannot
 * count as a clean revocation.
 */
export function scoreQuestion(question: GoldenQuestion, hits: ScoredHit[], abstainThreshold: number): QuestionOutcome {
  const top = hits.slice(0, 5);
  const rankIndex = top.findIndex((hit) => matches(hit.slug, question.expectSlugPrefixes));
  const leaked = top.some((hit) => matches(hit.slug, question.forbidSlugPrefixes));
  const best = top[0];
  const abstained = best === undefined || ((best.textRank ?? null) === null && (best.similarity ?? 0) < abstainThreshold);
  return {
    id: question.id,
    kind: question.kind,
    hit: question.kind === 'abstain' ? false : rankIndex >= 0,
    rank: rankIndex >= 0 ? rankIndex + 1 : null,
    abstainedCorrectly: question.kind === 'abstain' ? abstained : null,
    leaked,
    missedCurrent: question.kind === 'revoked' && question.expectSlugPrefixes.length > 0 && rankIndex < 0,
    top: best ? { slug: best.slug, similarity: best.similarity ?? null, textRank: best.textRank ?? null } : null,
  };
}

export function summarize(outcomes: QuestionOutcome[]): EvalSummary {
  const recall = outcomes.filter((o) => o.kind === 'recall');
  const abstain = outcomes.filter((o) => o.kind === 'abstain');
  const hits = recall.filter((o) => o.hit).length;
  const mrr = recall.reduce((sum, o) => sum + (o.rank ? 1 / o.rank : 0), 0);
  return {
    recallAt5: recall.length ? hits / recall.length : 0,
    mrrAt5: recall.length ? mrr / recall.length : 0,
    abstainPrecision: abstain.length ? abstain.filter((o) => o.abstainedCorrectly).length / abstain.length : 1,
    revocationLeaks: outcomes.filter((o) => o.leaked).length,
    revocationMisses: outcomes.filter((o) => o.missedCurrent).length,
    total: outcomes.length,
  };
}

export function renderTable(outcomes: QuestionOutcome[], summary: EvalSummary): string {
  const top = (o: QuestionOutcome): string => (o.top ? `${o.top.slug} (sim ${o.top.similarity ?? '-'}, kw ${o.top.textRank ?? '-'})` : '-');
  const rows = outcomes.map((o) => `| ${o.id} | ${o.kind} | ${o.kind === 'abstain' ? '-' : o.hit ? 'yes' : 'no'} | ${o.rank ?? '-'} | ${o.abstainedCorrectly === null ? '-' : o.abstainedCorrectly ? 'yes' : 'no'} | ${o.leaked ? 'LEAK' : o.missedCurrent ? 'MISS' : '-'} | ${top(o)} |`);
  return [
    '| id | kind | hit | rank | abstained | leak | top hit |',
    '|---|---|---|---|---|---|---|',
    ...rows,
    '',
    `recall@5 ${summary.recallAt5.toFixed(2)} · mrr@5 ${summary.mrrAt5.toFixed(2)} · abstain precision ${summary.abstainPrecision.toFixed(2)} · revocation leaks ${summary.revocationLeaks} · revocation misses ${summary.revocationMisses} · n=${summary.total}`,
  ].join('\n');
}
