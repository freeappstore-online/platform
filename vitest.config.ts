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
      // The MCP worker's pure helpers (workers/mcp has no test runner of its own).
      'workers/mcp/src/**/*.test.ts',
    ],
    environment: 'node',
  },
});
