import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['src/__tests__/**/*.test.ts'],
    testTimeout: 30000,
    hookTimeout: 10000,
    pool: 'forks', // isolate test files in separate processes for DB safety
  },
});
