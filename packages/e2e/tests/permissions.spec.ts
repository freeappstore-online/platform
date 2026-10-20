import { expect, test } from '@playwright/test';

/**
 * #285: listings show the browser permissions an app asks for, phone-first,
 * in light and dark. Runs against the live storefront like the other specs.
 * Each run attaches phone screenshots of the section to the report.
 */

const PHONE = { width: 390, height: 844 };

for (const colorScheme of ['light', 'dark'] as const) {
  test.describe(`permissions on a phone, ${colorScheme}`, () => {
    test.use({ viewport: PHONE, colorScheme });

    test('a listing shows its permissions with icon, name and text', async ({ page }, testInfo) => {
      await page.goto('https://freeappstore.online/apps/echoshift');
      const section = page.locator('#permissions');
      await section.scrollIntoViewIfNeeded();
      await expect(section.getByRole('heading', { name: 'Permissions' })).toBeVisible();
      const mic = section.locator('.perm-item', { hasText: 'Microphone' });
      await expect(mic).toBeVisible();
      await expect(mic.locator('.perm-icon')).toBeVisible();
      await expect(mic.locator('.perm-reason')).not.toBeEmpty();

      // The section follows the theme: its cards sit on the panel colour.
      const themed = await page.evaluate(() => document.documentElement.dataset.theme === 'dark');
      expect(themed).toBe(colorScheme === 'dark');
      const bg = await mic.evaluate((el) => getComputedStyle(el).backgroundColor);
      expect(bg).toBe(colorScheme === 'dark' ? 'rgb(30, 41, 59)' : 'rgb(255, 255, 255)');

      await testInfo.attach(`permissions-${colorScheme}`, {
        body: await section.screenshot(),
        contentType: 'image/png',
      });
    });

    test('an app that asks for nothing says so', async ({ page }) => {
      await page.goto('https://freeappstore.online/apps/music');
      await expect(page.locator('#permissions .perm-none')).toContainText(
        "doesn't ask for any permissions",
      );
    });

    test('the app card shows a labelled permission icon row', async ({ page }) => {
      await page.goto('https://freeappstore.online');
      const perms = page.locator('.app-card.compact[data-id="echoshift"] .app-perms');
      await expect(perms).toHaveAttribute('aria-label', /Microphone/);
    });
  });
}
