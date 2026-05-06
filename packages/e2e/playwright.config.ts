import { defineConfig, devices } from '@playwright/test';

/**
 * Playwright tests run against live deployments — no local dev server,
 * no fixtures. Catches regressions that unit tests can't see (real
 * fullscreen API behavior, real fonts loading, real iframe timing).
 *
 * Each test file targets a specific live app/page; they're independent
 * and can run in parallel. Failures don't block deploys (yet) — this
 * is a watchdog, not a gate. Add `pnpm test:e2e` to release process
 * when test count + stability justifies it.
 */
export default defineConfig({
  testDir: './tests',
  fullyParallel: true,
  retries: process.env.CI ? 2 : 0,
  workers: process.env.CI ? 2 : undefined,
  reporter: process.env.CI ? [['github'], ['list']] : 'list',
  timeout: 30_000,
  expect: { timeout: 10_000 },
  use: {
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    actionTimeout: 8_000,
    navigationTimeout: 15_000,
  },
  projects: [
    {
      name: 'desktop',
      use: { ...devices['Desktop Chrome'] },
    },
    {
      name: 'mobile',
      use: { ...devices['iPhone 14'] },
    },
  ],
});
