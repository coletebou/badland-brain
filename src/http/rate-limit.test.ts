import { describe, expect, it } from 'vitest';

import { RateLimiter } from './rate-limit.js';

describe('RateLimiter', () => {
  it('counts units per id in one-minute windows and says when the window resets', () => {
    let now = 1_000_000;
    const limiter = new RateLimiter(3, () => now);
    expect(limiter.take('a', 2)).toEqual({ ok: true });
    expect(limiter.take('b', 3)).toEqual({ ok: true });
    expect(limiter.take('a', 2)).toEqual({ ok: false, retryAfterSeconds: 60 });
    expect(limiter.take('a')).toEqual({ ok: true });
    now += 45_000;
    expect(limiter.take('a')).toEqual({ ok: false, retryAfterSeconds: 15 });
    now += 15_000;
    expect(limiter.take('a', 3)).toEqual({ ok: true });
  });
});
