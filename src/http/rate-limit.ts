/**
 * Fixed one-minute windows per key, kept in memory: a restart forgives everything, and several server processes each
 * keep their own count. Enough to stop a runaway agent loop; not an abuse shield for a public endpoint.
 */
export class RateLimiter {
  private readonly windows = new Map<string, { start: number; used: number }>();

  constructor(private readonly perMinute: number, private readonly now: () => number = Date.now) {}

  /** Spend `cost` units for `id`; on refusal, the seconds until the window resets. */
  take(id: string, cost = 1): { ok: true } | { ok: false; retryAfterSeconds: number } {
    const now = this.now();
    let window = this.windows.get(id);
    if (!window || now - window.start >= 60_000) {
      window = { start: now, used: 0 };
      this.windows.set(id, window);
      this.prune(now);
    }
    if (window.used + cost > this.perMinute) {
      return { ok: false, retryAfterSeconds: Math.max(1, Math.ceil((window.start + 60_000 - now) / 1000)) };
    }
    window.used += cost;
    return { ok: true };
  }

  private prune(now: number): void {
    if (this.windows.size < 1_000) {
      return;
    }
    for (const [id, window] of this.windows) {
      if (now - window.start >= 60_000) {
        this.windows.delete(id);
      }
    }
  }
}
