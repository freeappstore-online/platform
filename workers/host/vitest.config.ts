import { defineConfig } from 'vitest/config';
export default defineConfig({
  test: {
    environment: 'node',
    // Unit tests only; test/runtime/ runs in workerd via vitest.runtime (#7).
    include: ['src/**/*.test.ts'],
    reporters: ['default', 'json'],
    outputFile: { json: 'test-results/results.json' },
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json-summary'],
      reportsDirectory: './test-results/coverage',
    },
  },
});
