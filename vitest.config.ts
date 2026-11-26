import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['src/**/*.test.ts', 'integrations/**/*.test.{js,ts}'],
    testTimeout: 60_000,
    hookTimeout: 120_000,
    restoreMocks: true,
    // Four workers that are reused across files. Measured on 5.1.2 (23 files, 259 tests, each
    // file starting its own in-memory MongoDB): the same wall time as fifteen isolated workers
    // with a third less memory. If a suite ever needs a clean module graph, set `isolate: true`
    // again instead of working around it in the test.
    isolate: false,
    maxWorkers: 4,
  },
});
