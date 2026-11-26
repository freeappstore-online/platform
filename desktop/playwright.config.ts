import { defineConfig } from '@playwright/test';

// End-to-end: launches the built Electron app (run `pnpm build` first, or `pnpm test:e2e`).
export default defineConfig({
  testDir: 'e2e',
  timeout: 90_000,
  workers: 1,
  reporter: 'list',
});
