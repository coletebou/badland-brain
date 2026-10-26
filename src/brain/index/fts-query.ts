const TOKEN = /[\p{L}\p{N}_][\p{L}\p{N}_.-]*/gu;
const EDGE_PUNCTUATION = /^[.-]+|[.-]+$/gu;
const MAX_TOKENS = 12;
const MIN_TOKEN_CHARS = 2;
/** Function words that would otherwise match nearly every chunk once tokens are ORed. */
const STOPWORDS = new Set(['the', 'a', 'an', 'of', 'is', 'are', 'was', 'were', 'be', 'to', 'in', 'on', 'for', 'and', 'or', 'not', 'no',
  'what', 'which', 'how', 'when', 'where', 'who', 'why', 'do', 'does', 'did', 'it', 'this', 'that', 'these', 'those', 'with', 'at',
  'by', 'from', 'as', 'i', 'my', 'me', 'we', 'our', 'you', 'your', 'can', 'could', 'should', 'would', 'will', 'has', 'have', 'had', 'about']);

/**
 * Turn free text into an FTS5 MATCH expression that cannot reach the FTS5 query parser: every token is quoted and the
 * tokens are ORed, so a natural question still reaches the keyword leg and BM25 ranks multi-term matches higher.
 * Identifiers such as `deploy-bot` or `retry_budget` survive because the tokenizer keeps `_` and `-` inside a token.
 */
export function buildFtsQuery(text: string): string | null {
  const seen = new Set<string>();
  for (const match of text.toLowerCase().matchAll(TOKEN)) {
    const token = match[0].replace(EDGE_PUNCTUATION, '');
    if (token.length < MIN_TOKEN_CHARS || seen.has(token) || STOPWORDS.has(token)) {
      continue;
    }
    seen.add(token);
    if (seen.size === MAX_TOKENS) {
      break;
    }
  }
  if (seen.size === 0) {
    return null;
  }
  return [...seen].map((token) => `"${token.replaceAll('"', '""')}"`).join(' OR ');
}
