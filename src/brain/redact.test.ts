import { describe, expect, it } from 'vitest';

import { findSecretShapes } from './redact.js';

// Shapes are assembled at run time so this file never holds a literal that looks like a credential.
const brainKey = `bbk_${'a'.repeat(43)}`;

describe('findSecretShapes', () => {
  it('names the shapes it finds, in pattern order', () => {
    const text = `key ${brainKey} and AKIA${'B'.repeat(16)}`;
    expect(findSecretShapes(text)).toEqual(['brain-api-key', 'aws-access-key']);
  });

  it('returns nothing for ordinary prose, identifiers, and ports', () => {
    expect(findSecretShapes('Use pnpm on deploy-bot; port 4310. Bearer tokens are minted by the keys command.')).toEqual([]);
    expect(findSecretShapes('The skeleton key is not a secret')).toEqual([]);
    expect(findSecretShapes('bbk_ prefixes mark brain keys; npm_ and glpat- are other prefixes')).toEqual([]);
  });

  it('catches bearer headers, private keys, google keys, and JWTs', () => {
    expect(findSecretShapes(`Authorization: Bearer ${'x'.repeat(20)}`)).toEqual(['bearer-token']);
    expect(findSecretShapes(['-----BEGIN', 'PRIVATE KEY-----\nabc\n-----END PRIVATE KEY-----'].join(' '))).toEqual(['private-key']);
    expect(findSecretShapes(`AIza${'Q'.repeat(35)}`)).toEqual(['google-api-key']);
    expect(findSecretShapes(`token eyJ${'a'.repeat(10)}.${'b'.repeat(10)}.${'c'.repeat(10)}`)).toEqual(['jwt']);
  });

  it('catches GitHub, GitLab, npm, Stripe and Slack tokens', () => {
    expect(findSecretShapes(`ghp_${'k'.repeat(24)}`)).toEqual(['github-token']);
    expect(findSecretShapes(`glpat-${'k'.repeat(20)}`)).toEqual(['gitlab-token']);
    expect(findSecretShapes(`npm_${'k'.repeat(36)}`)).toEqual(['npm-token']);
    expect(findSecretShapes(`${'sk'}_live_${'k'.repeat(24)}`)).toEqual(['stripe-key']);
    expect(findSecretShapes(`xoxb-${'1'.repeat(12)}`)).toEqual(['slack-token']);
  });

  it('is stable across repeated calls (no global regex state)', () => {
    const text = `sk-${'z'.repeat(24)}`;
    expect(findSecretShapes(text)).toEqual(['openai-style-key']);
    expect(findSecretShapes(text)).toEqual(['openai-style-key']);
  });
});
