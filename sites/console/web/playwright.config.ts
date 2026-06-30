import { defineConfig } from '@playwright/test';

// Mirrors fws/platform/packages/create's setup — tests run against prod
// (console.proappstore.online) and stay public-only (auth-gated flows
// require a real FAS session token, out of scope for default CI run).
export default defineConfig({
  testDir: './e2e',
  timeout: 30_000,
  // Retry transient failures in CI — deploy-just-finished CDN propagation
  // races, network jitter. Locally fail fast.
  retries: process.env.CI ? 2 : 0,
  use: {
    baseURL: 'https://console.proappstore.online',
    headless: true,
    // The console ships a PWA service worker (vite-plugin-pwa with
    // generateSW + autoUpdate). When Playwright navigates, the SW
    // intercepts the page-load chain and the default `waitUntil: 'load'`
    // can hang past the timeout if any precached resource stalls.
    // Block the SW entirely for tests — we're not testing the SW here.
    serviceWorkers: 'block',
  },
  projects: [{ name: 'chromium', use: { browserType: 'chromium' } }],
});
