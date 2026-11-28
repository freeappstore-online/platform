import { readFileSync } from 'node:fs';
import { extname } from 'node:path';
import { expect, type Page, test } from '@playwright/test';

async function prepare(page: Page) {
  await page.route('**/*', async (route) => {
    const url = new URL(route.request().url());
    if (url.hostname !== 'layout.test') return route.abort();
    const name = url.pathname === '/' ? 'index.html' : url.pathname.slice(1);
    if (name.includes('..')) return route.abort();
    const type: Record<string, string> = {
      '.html': 'text/html',
      '.js': 'application/javascript',
      '.css': 'text/css',
      '.svg': 'image/svg+xml',
    };
    await route.fulfill({
      body: readFileSync(new URL(`../dist/renderer/${name}`, import.meta.url)),
      contentType: type[extname(name)],
    });
  });
  await page.addInitScript(() => {
    const noop = async () => {};
    const state = {
      version: '0.6.0 (123, abc1234)',
      releaseNotes: 'https://example.test/release',
      mcpUrl: 'http://127.0.0.1:47821/mcp',
      setupCommand: 'example '.repeat(60),
      serverError: null,
      paused: false,
      openAtLogin: false,
      store: { recent: [], favorites: [] },
      updates: {
        status: 'manual',
        version: '0.7.0',
        percent: null,
        error: null,
        checkedAt: null,
        auto: true,
        supported: true,
      },
      openApps: [
        {
          appId: 'spreadsheet',
          title: 'Spreadsheet',
          source: 'desktop',
          tools: [
            {
              name: 'a_very_long_tool_name_to_check_wrapping',
              description: 'Read the workbook',
              inputSchema: {},
            },
          ],
        },
      ],
      log: [
        {
          id: 1,
          at: Date.now(),
          tool: 'app_call',
          appId: 'spreadsheet',
          appTool: 'a_very_long_tool_name_to_check_wrapping',
          ok: false,
          error: `Long error: ${'x'.repeat(100)}`,
        },
      ],
      profile: {
        avatar: null,
        user: {
          id: 'gh:1',
          name: 'A long account display name',
          login: 'example',
          provider: 'github',
          email: 'long-address@example.test',
          roles: ['user', 'creator'],
          appCount: 10,
        },
        device: {
          id: 'd1',
          label: 'My desktop computer',
          createdAt: Date.now(),
          expiresAt: Date.now() + 86400000,
        },
      },
      publish: {
        account: { login: 'example', expired: false },
        signIn: null,
        apps: [],
        projects: [
          {
            path: '/tmp/project-with-a-long-name',
            appId: 'sample',
            changes: 1,
            checks: [{ name: 'Check', status: 'pass', detail: 'All checks passed' }],
          },
        ],
        task: { label: 'Check project', running: false, ok: true, output: ['x'.repeat(150)] },
      },
      contribute: {
        connected: true,
        pairing: false,
        pairError: null,
        optedIn: [],
        mode: 'auto',
        status: 'paused',
        message: 'Computer in use',
        runNow: false,
        apps: [],
        appsLoading: false,
        appsError: null,
        current: null,
        submitted: 0,
        skipped: 0,
        failed: 0,
        historyVersion: 0,
        model: {
          engine: 'Kokoro',
          languages: 'English, Spanish and Mandarin',
          bytes: 350000000,
          ready: true,
          loading: null,
          stage: 'download',
        },
        when: {
          onBattery: false,
          minBattery: 40,
          thermalPause: true,
          inUse: 'pause',
          cpu: 'balanced',
          dailyJobs: 0,
          dailyMinutes: 0,
          quietHours: true,
          quietFrom: 1320,
          quietTo: 420,
        },
      },
    };
    const api = {
      state: async () => state,
      onState() {},
      clients: async () => [],
      registry: async () => ({
        apps: [
          {
            id: 'sample',
            name: 'An app with a long name',
            category: 'utilities',
            description: 'A useful application for everyone.',
          },
        ],
        votes: {},
      }),
      releaseNotes: async () => ({
        version: '0.6.0',
        body: `Release notes ${'x'.repeat(150)}`,
        published: '2026-11-27',
      }),
      pairCode: async () => ({
        code: 'ABCD-EFGH-JKMN-PQRS',
        url: 'freeappstore://native/pair?code=ABCDEFGHIJKLMNOP',
        expiresAt: Date.now() + 300000,
      }),
      publish: { refresh: noop },
      contribute: { history: async () => [], refresh: noop },
    };
    Object.assign(window, { fasDesktop: api });
  });
  await page.goto('http://layout.test/');
  await expect(page.getByTestId('status')).toBeVisible();
  await page.evaluate(() => {
    document.documentElement.dataset.text = 'xxl';
  });
}

async function noHorizontalScroll(page: Page) {
  const overflow = await page.evaluate(() => {
    const width = document.documentElement.clientWidth;
    const bad = [...document.querySelectorAll<HTMLElement>('body *')].filter((el) => {
      const rect = el.getBoundingClientRect();
      const css = getComputedStyle(el);
      return (
        rect.width > 0 &&
        rect.height > 0 &&
        !el.closest('svg') &&
        (rect.right > width + 1 ||
          (el.scrollWidth > el.clientWidth + 1 && ['auto', 'scroll'].includes(css.overflowX)))
      );
    });
    return {
      page: document.documentElement.scrollWidth - width,
      elements: bad.map((el) => `${el.tagName}: ${el.textContent?.slice(0, 80)}`),
    };
  });
  expect(overflow).toEqual({ page: 0, elements: [] });
}

for (const width of [420, 800, 1100]) {
  test(`A+++ reflows all desktop pages at ${width}px without horizontal scrolling`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 1000 });
    await prepare(page);
    for (const name of ['Home', 'Store', 'Publish', 'Contribute', 'Activity']) {
      await page
        .getByRole('navigation', { name: 'Main' })
        .getByRole('button', { name, exact: true })
        .click();
      await noHorizontalScroll(page);
      if (name === 'Publish') {
        await page.getByRole('button', { name: 'New app', exact: true }).click();
        await noHorizontalScroll(page);
      }
    }
    await page.getByTestId('profile-summary').click();
    await page.getByRole('button', { name: 'Show a code', exact: true }).click();
    await expect(page.getByTestId('pair-code')).toBeVisible();
    await noHorizontalScroll(page);
    await page.screenshot({ path: `test-results/shots/layout-xxl-${width}.png`, fullPage: true });
  });
}
