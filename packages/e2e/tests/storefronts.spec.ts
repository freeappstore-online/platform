import { expect, test } from '@playwright/test';

/**
 * Smoke tests for the public storefronts. Catches: storefront down,
 * the build dropped HTML structure we depend on (eg. lost the apps
 * grid), CSS regressions (lost split layout), or registry drift.
 */

test('freeappstore.online homepage renders the apps grid', async ({ page }) => {
  await page.goto('https://freeappstore.online');
  // Apps grid must contain at least one card. If the registry break
  // shipped empty, this fails.
  const cards = page.locator('.app-card');
  await expect(cards.first()).toBeVisible();
  expect(await cards.count()).toBeGreaterThan(5);
});

test('freegamestore.online homepage renders the games grid', async ({ page }) => {
  await page.goto('https://freegamestore.online');
  const cards = page.locator('.app-card');
  await expect(cards.first()).toBeVisible();
  expect(await cards.count()).toBeGreaterThan(5);
});

test('an app detail page has the modern layout: split + phone-frame + history', async ({
  page,
}) => {
  await page.goto('https://freeappstore.online/apps/tip');
  // The split container exists with both halves.
  await expect(page.locator('.app-split')).toBeVisible();
  await expect(page.locator('.app-split-info')).toBeVisible();
  await expect(page.locator('.app-split-phone')).toBeVisible();
  // Phone-frame iframe renders the live app.
  const iframe = page.locator('.phone-frame iframe');
  await expect(iframe).toBeVisible();
  await expect(iframe).toHaveAttribute('src', /tip\.freeappstore\.online/);
  // Recent updates section present.
  await expect(page.getByRole('heading', { name: 'Recent updates' })).toBeVisible();
});
