import { resolve } from 'node:path';
import { defineConfig, devices } from '@playwright/test';

const scaffold = process.env.SCAFFOLD_DIR;
const artifact = process.env.SCAFFOLD_ARTIFACT === '1';
if (!scaffold) throw new Error('Set SCAFFOLD_DIR to a freshly initialized app');
export default defineConfig({
  testDir: './scaffold',
  testMatch: artifact
    ? ['**/artifact.spec.ts', '**/pwa.spec.ts', '**/forms.spec.ts']
    : '**/shell.spec.ts',
  workers: 1,
  timeout: 60_000,
  retries: 0,
  reporter: 'list',
  use: {
    baseURL: 'http://127.0.0.1:5194',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  projects: [
    { name: 'desktop', use: { ...devices['Desktop Chrome'] } },
    { name: 'mobile', use: { ...devices['iPhone 14'], defaultBrowserType: 'chromium' } },
    ...(artifact
      ? [
          {
            name: 'webkit-icons',
            testMatch: '**/artifact.spec.ts',
            use: { ...devices['iPhone 14'], defaultBrowserType: 'webkit' as const },
          },
        ]
      : []),
  ],
  webServer: {
    command: artifact
      ? 'pnpm --filter "./web" exec vite preview --host 127.0.0.1 --port 5194 --strictPort'
      : 'pnpm --filter "./web" dev --host 127.0.0.1 --port 5194 --strictPort',
    cwd: resolve(scaffold),
    url: 'http://127.0.0.1:5194',
    reuseExistingServer: false,
  },
});
