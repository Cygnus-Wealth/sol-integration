import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node', // E2E tests run in Node environment
    globals: true,
    testTimeout: 60000, // 60 second timeout for network calls
    hookTimeout: 30000, // 30 second timeout for setup/teardown
    include: ['src/test/e2e/**/*.test.ts'],
    reporters: ['verbose'], // Detailed output for E2E tests
    retry: 2, // Retry failed tests up to 2 times
    pool: 'forks', // Use separate processes for stability
    poolOptions: {
      forks: {
        singleFork: true // Run tests sequentially to avoid rate limits
      }
    }
  }
});