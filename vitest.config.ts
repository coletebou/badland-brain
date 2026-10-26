import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['src/**/*.test.ts', 'integrations/**/*.test.{js,ts}'],
    testTimeout: 60_000,
    hookTimeout: 120_000,
    restoreMocks: true,
  },
});
