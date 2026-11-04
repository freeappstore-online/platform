import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { expect, test } from '@playwright/test';

test('PWA preserves work across activation, reloads offline deep links and supports enlarged text', async ({
  page,
  context,
}) => {
  test.setTimeout(90_000);
  // The connected fixture uses a synthetic session. Keep backend responses
  // deterministic so a real 401 cannot sign out the app mid-lifecycle test.
  // Only intercept the API; service workers, assets and offline navigation
  // continue through the real built artifact.
  await page.route('https://api.freeappstore.online/**', (route) =>
    new URL(route.request().url()).pathname === '/v1/analytics.js'
      ? route.fulfill({ contentType: 'application/javascript', body: '' })
      : route.fulfill({ json: { value: null, friends: [], requests: [] } }),
  );
  if (process.env.SCAFFOLD_TEMPLATE === 'connected')
    await page.addInitScript(() =>
      localStorage.setItem(
        'fas:session',
        JSON.stringify({
          token: 'pwa-test',
          user: { id: 'gh:1', login: 'testuser', avatarUrl: null, dateOfBirth: '2000-01-01' },
        }),
      ),
    );
  await page.goto('/');
  await page.evaluate(() => navigator.serviceWorker.ready);
  await expect.poll(() => page.evaluate(() => !!navigator.serviceWorker.controller)).toBe(true);
  const viewport = await page.locator('meta[name="viewport"]').getAttribute('content');
  expect(viewport).not.toMatch(/maximum-scale|user-scalable\s*=\s*(no|0)/);
  const manifest = await (await context.request.get('/manifest.json')).json();
  expect(manifest.display).toBe('standalone');
  for (const icon of manifest.icons) expect((await context.request.get(icon.src)).ok()).toBe(true);
  await page.setViewportSize({ width: 320, height: 760 });
  await page.addStyleTag({ content: 'html { font-size: 200%; }' });
  expect(
    await page.evaluate(
      (width) => document.documentElement.scrollWidth <= width,
      page.viewportSize()!.width,
    ),
  ).toBe(true);
  await page.getByRole('textbox', { name: 'Unsaved note' }).fill('Keep this work');
  const swPath = resolve(process.env.SCAFFOLD_DIR!, 'web/dist/sw.js');
  const original = await readFile(swPath, 'utf8');
  try {
    await writeFile(swPath, `${original}\n// update regression ${Date.now()}\n`);
    await page.evaluate(async () => {
      await (await navigator.serviceWorker.ready).update();
    });
    const activate = page.getByRole('button', { name: 'Activate update', exact: true });
    await expect(activate).toBeVisible();
    await activate.click();
    expect(await page.evaluate(async () => !!(await navigator.serviceWorker.ready).waiting)).toBe(
      true,
    );
    await page.getByRole('button', { name: 'Save note', exact: true }).click();
    await page.getByRole('button', { name: 'Start recording', exact: true }).click();
    await activate.click();
    expect(await page.evaluate(async () => !!(await navigator.serviceWorker.ready).waiting)).toBe(
      true,
    );
    await page.getByRole('button', { name: 'Stop recording', exact: true }).click();
    await activate.click();
    const reload = page.getByRole('button', { name: 'Reload app', exact: true });
    await expect(reload).toBeVisible();
    await expect(page.getByRole('textbox', { name: 'Unsaved note' })).toHaveValue('Keep this work');
    await page.getByRole('textbox', { name: 'Unsaved note' }).fill('New unsaved work');
    await reload.click();
    await expect(page.getByRole('textbox', { name: 'Unsaved note' })).toHaveValue(
      'New unsaved work',
    );
    await page.getByRole('button', { name: 'Save note', exact: true }).click();
    await reload.click();
    await expect(page.getByRole('textbox', { name: 'Unsaved note' })).toHaveValue('');
    await context.setOffline(true);
    await page.reload();
    await expect(page.getByRole('main')).toBeVisible();
    await expect(
      page.getByRole('complementary', { name: 'App installation and updates' }),
    ).toContainText('Only the downloaded app shell');
    await page.goto('/never-visited/deep-link');
    await expect(page.getByRole('main')).toBeVisible();
    expect(new URL(page.url()).pathname).toBe('/never-visited/deep-link');
  } finally {
    await context.setOffline(false);
    await writeFile(swPath, original);
  }
});
