// Leading hyphens are kept: the tokenizer keeps `-` inside a token, so a CLI flag is indexed as `--frozen-lockfile`.
const TOKEN = /-*[\p{L}\p{N}_][\p{L}\p{N}_.-]*/gu;
const TRAILING_PUNCTUATION = /[.-]+$/gu;
const LEADING_HYPHENS = /^-+/u;
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
 * A flag is searched both as written and bare (`--frozen-lockfile` and `frozen-lockfile`), so it matches where it is
 * quoted as a flag and where it is named in prose.
 */
export function buildFtsQuery(text: string): string | null {
  const seen = new Set<string>();
  tokens: for (const match of text.toLowerCase().matchAll(TOKEN)) {
    const token = match[0].replace(TRAILING_PUNCTUATION, '');
    const bare = token.replace(LEADING_HYPHENS, '');
    for (const candidate of token === bare ? [token] : [token, bare]) {
      if (candidate.length < MIN_TOKEN_CHARS || seen.has(candidate) || STOPWORDS.has(candidate)) {
        continue;
      }
      seen.add(candidate);
      if (seen.size === MAX_TOKENS) {
        break tokens;
      }
    }
  }
  if (seen.size === 0) {
    return null;
  }
  return [...seen].map((token) => `"${token.replaceAll('"', '""')}"`).join(' OR ');
}
