/**
 * Secret shapes that must never land in the brain. A match rejects the write (or the search, whose query leaves the
 * process for the embedding provider) instead of masking it, and only the pattern name is ever reported.
 */
export const SECRET_PATTERNS: ReadonlyArray<{ name: string; pattern: RegExp }> = [
  // PEM private keys of every kind, and armored OpenPGP private keys (`... PRIVATE KEY BLOCK-----`).
  { name: 'private-key', pattern: /-----BEGIN [A-Z ]{0,40}PRIVATE KEY(?: BLOCK)?-----/u },
  { name: 'brain-api-key', pattern: /\bbbk_[A-Za-z0-9_-]{20,}/u },
  { name: 'openai-style-key', pattern: /\bsk-(?:ant-|proj-|or-)?[A-Za-z0-9_-]{20,}/u },
  { name: 'github-token', pattern: /\b(?:ghp|gho|ghu|ghs|ghr|github_pat)_[A-Za-z0-9_]{20,}/u },
  { name: 'gitlab-token', pattern: /\bglpat-[A-Za-z0-9_-]{20,}/u },
  { name: 'npm-token', pattern: /\bnpm_[A-Za-z0-9]{36}\b/u },
  { name: 'stripe-key', pattern: /\b(?:sk|rk)_live_[A-Za-z0-9]{20,}/u },
  // Bot, user, refresh and configuration (xoxe-), browser-session (xoxc-, with its xoxd- cookie) and legacy tokens,
  // and app-level tokens (xapp-). Not xoxo-, which is ordinary prose far more often than a long-retired token.
  { name: 'slack-token', pattern: /\b(?:xox[abcdeprs]|xapp)-[A-Za-z0-9-]{10,}/u },
  // Long-term (AKIA) and temporary STS (ASIA) access key ids, and the STS bearer-token and context-specific credential ids.
  { name: 'aws-access-key', pattern: /\b(?:AKIA|ASIA|ABIA|ACCA)[0-9A-Z]{16}\b/u },
  { name: 'google-api-key', pattern: /\bAIza[0-9A-Za-z_-]{35}(?![A-Za-z0-9_-])/u },
  { name: 'jwt', pattern: /(?<![A-Za-z0-9_-])eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/u },
  { name: 'bearer-token', pattern: /\bBearer\s+[A-Za-z0-9._~+/=-]{16,}/iu },
];

/** Names of every secret shape present in `text`, in pattern order, without duplicates. */
export function findSecretShapes(text: string): string[] {
  return SECRET_PATTERNS.filter(({ pattern }) => pattern.test(text)).map(({ name }) => name);
}
