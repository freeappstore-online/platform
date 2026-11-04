import { expect, test } from '@playwright/test';

test('produced artifact renders navigation and persists a real theme change', async ({ page }) => {
  const connected = process.env.SCAFFOLD_TEMPLATE === 'connected';
  if (connected)
    await page.addInitScript(() =>
      localStorage.setItem(
        'fas:session',
        JSON.stringify({
          token: 'artifact-browser-test',
          user: { id: 'gh:1', login: 'testuser', avatarUrl: null, dateOfBirth: '2000-01-01' },
        }),
      ),
    );
  await page.route('https://api.freeappstore.online/**', (route) =>
    route.fulfill({ json: { value: null, friends: [], requests: [] } }),
  );
  await page.goto('/');
  await expect(page.getByRole('main')).toBeVisible();
  await expect(page.getByRole('status', { name: 'Task count' })).toHaveText('0');
  await page.getByRole('button', { name: 'Add task', exact: true }).click();
  await expect(page.getByRole('status', { name: 'Task count' })).toHaveText('1');
  const menu = page.getByRole('button', { name: 'Menu', exact: true });
  if (await menu.isVisible()) await menu.click();
  await page
    .getByRole('navigation')
    .getByRole('link', { name: connected ? 'Profile' : 'About', exact: true })
    .click();
  if (connected) {
    await page.getByRole('button', { name: 'Dark', exact: true }).click();
  } else {
    await page.getByRole('button', { name: 'Theme: system', exact: true }).click();
    await page.getByRole('button', { name: 'Theme: light', exact: true }).click();
  }
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  await page.reload();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
});
