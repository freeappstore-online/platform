import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: [
      'packages/*/src/**/*.test.ts',
      'packages/*/src/**/*.test.tsx',
      'packages/*/src/**/*.test.mts',
      // The creator console's logic modules. sites/ was previously outside the
      // suite entirely, so nothing under it was tested (#32).
      'sites/*/web/src/**/*.test.ts',
      // Repo-level policy checks (e.g. issue routing, #265).
      'scripts/**/*.test.ts',
    ],
    environment: 'node',
  },
});
