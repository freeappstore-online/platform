import { expect, test } from '@playwright/test';

test('installation belongs to Profile without a promotion footer or OAuth', async ({ page }) => {
  await page.route('https://api.freeappstore.online/**', (route) =>
    route.fulfill({ json: { value: null, friends: [], requests: [] } }),
  );
  await page.goto('/');
  await page.evaluate(() => {
    window.dispatchEvent(
      Object.assign(new Event('beforeinstallprompt', { cancelable: true }), {
        prompt: async () => {
          document.documentElement.dataset.installRequested = 'yes';
        },
      }),
    );
  });
  const install = page.getByRole('button', { name: 'Install app', exact: true });
  await expect(install).toHaveCount(0);
  await expect(
    page.getByRole('complementary', { name: 'App installation and updates' }),
  ).toBeHidden();
  await page.locator('header a[aria-label="Profile"]').click();
  await expect(install).toBeVisible();
  await install.click();
  await expect(page.locator('html')).toHaveAttribute('data-install-requested', 'yes');
  await expect(install).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Sign in with GitHub' })).toBeVisible();
  expect(new URL(page.url()).pathname).toBe('/profile');
});

test('produced artifact renders navigation and persists a real theme change', async ({ page }) => {
  const connected = process.env.SCAFFOLD_TEMPLATE === 'connected';
  await page.route('https://api.freeappstore.online/**', (route) =>
    route.fulfill({ json: { value: null, friends: [], requests: [] } }),
  );
  await page.goto('/');
  const iconHref = await page.locator('link[rel~="icon"]').first().getAttribute('href');
  expect(iconHref).toBeTruthy();
  const icon = await page.request.get(new URL(iconHref!, page.url()).href);
  expect(icon.ok()).toBe(true);
  expect(icon.headers()['content-type']).toMatch(/^image\//);

  await expect(page.getByRole('main')).toBeVisible();
  await expect(page.getByRole('status', { name: 'Task count' })).toHaveText('0');
  await page.getByRole('button', { name: 'Add task', exact: true }).click();
  await expect(page.getByRole('status', { name: 'Task count' })).toHaveText('1');
  const menu = page.getByRole('button', { name: 'Menu', exact: true });
  if (await menu.isVisible()) await menu.click();
  await page.getByRole('navigation').getByRole('link', { name: 'About', exact: true }).click();
  await expect(
    page.getByRole('main').getByRole('heading', { name: 'About', exact: true }),
  ).toBeVisible();
  await page.locator('header a[aria-label="Profile"]').click();
  await expect(page.getByRole('heading', { name: 'Profile', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Sign in with GitHub' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Sign in with Google' })).toBeVisible();
  if (connected) {
    await page.getByRole('link', { name: 'Close profile', exact: true }).click();
    const homeMenu = page.getByRole('button', { name: 'Menu', exact: true });
    if (await homeMenu.isVisible()) await homeMenu.click();
    await page.getByRole('navigation').getByRole('link', { name: 'Home', exact: true }).click();
    await expect(
      page.getByText(
        'Sign in to load or save your private draft. Public parts of the app remain available.',
      ),
    ).toBeVisible();
    await page.locator('header a[aria-label="Profile"]').click();
  }
  await page.getByRole('button', { name: 'Dark', exact: true }).click();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  await page.reload();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
});
