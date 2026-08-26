import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // One database, shared fixtures: parallel files would race on truncation.
    fileParallelism: false,
    sequence: { concurrent: false },
    setupFiles: ['tests/env.ts'],
    testTimeout: 30_000,
    include: ['tests/**/*.test.ts'],
  },
});
