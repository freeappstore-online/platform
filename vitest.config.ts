import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['packages/*/src/**/*.test.ts', 'packages/*/src/**/*.test.tsx', 'packages/*/src/**/*.test.mts'],
    environment: 'node',
  },
});
