import { describe, expect, it } from 'vitest';

import { buildFtsQuery } from './fts-query.js';

describe('buildFtsQuery', () => {
  it('quotes tokens, keeps identifiers, drops one-character tokens, and ORs them', () => {
    expect(buildFtsQuery('deploy-bot retry_budget x')).toBe('"deploy-bot" OR "retry_budget"');
    expect(buildFtsQuery('config.gateway.port')).toBe('"config.gateway.port"');
  });

  it('neutralises FTS syntax and quotes', () => {
    expect(buildFtsQuery('foo OR "bar" NEAR(baz)')).toBe('"foo" OR "bar" OR "near" OR "baz"');
    expect(buildFtsQuery('col:value ^prefix *')).toBe('"col" OR "value" OR "prefix"');
  });

  it('strips edge punctuation, dedupes case-insensitively, caps at 12 tokens, returns null when empty', () => {
    expect(buildFtsQuery('Foo foo FOO')).toBe('"foo"');
    expect(buildFtsQuery('-trailing- .dotted.')).toBe('"trailing" OR "dotted"');
    expect(buildFtsQuery('a  -  !')).toBeNull();
    expect(buildFtsQuery('what is the of')).toBeNull();
    expect(buildFtsQuery('what is the capital of')).toBe('"capital"');
    expect(buildFtsQuery('which port does preview-server use')).toBe('"port" OR "preview-server" OR "use"');
    expect(buildFtsQuery('')).toBeNull();
    const many = Array.from({ length: 20 }, (_, i) => `token${i}`).join(' ');
    expect(buildFtsQuery(many)?.split(' OR ')).toHaveLength(12);
  });
});
