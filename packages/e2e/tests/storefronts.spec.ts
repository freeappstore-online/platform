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
  // Detail-page metadata styles must never add padding and divider lines to cards.
  const meta = cards.first().locator('.app-meta');
  expect(await meta.evaluate((el) => getComputedStyle(el).paddingTop)).toBe('0px');
  expect(await meta.evaluate((el) => getComputedStyle(el).borderTopWidth)).toBe('0px');
  const cardBox = await cards.first().boundingBox();
  expect(cardBox?.height).toBeLessThan(110);
  await expect(page.locator('#previewPane')).toBeHidden();

  // The footer must remain in normal flow, including at the mobile breakpoint.
  const footer = page.getByRole('navigation', { name: 'Footer', exact: true });
  expect(await footer.evaluate((el) => getComputedStyle(el).position)).toBe('static');
  await footer.scrollIntoViewIfNeeded();
  await expect(footer.getByRole('link', { name: 'Developer resources' })).toBeInViewport();
});

test('desktop app preview opens on selection and close restores the catalogue', async ({
  page,
  isMobile,
}) => {
  test.skip(isMobile, 'Mobile cards navigate to app details.');
  await page.goto('https://freeappstore.online');
  const card = page.locator('#apps-grid .app-card').first();
  await card.focus();
  await card.press('Enter');
  await expect(page.locator('#previewPane')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Open in new tab', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Close preview', exact: true }).click();
  await expect(page.locator('#previewPane')).toBeHidden();
  await expect(card).toBeFocused();
  expect(new URL(page.url()).searchParams.has('app')).toBe(false);
});

test('freegamestore.online homepage renders the games grid', async ({ page }) => {
  await page.goto('https://freegamestore.online');
  const cards = page.locator('.app-card');
  await expect(cards.first()).toBeVisible();
  expect(await cards.count()).toBeGreaterThan(5);
});

/** Listing id + configured preview URL from a catalogue card. */
async function readCard(card) {
  const id =
    (await card.getAttribute('data-id')) ||
    (await card.getAttribute('data-about'))?.match(/^\/apps\/([^/]+)\/?$/)?.[1];
  // The Open CTA href is the registry appUrl, which can be a custom
  // hostname (Yi: id=hanzi-associations, preview=https://yi.freeappstore.online).
  const previewUrl = await card.locator('a.app-cta').getAttribute('href');
  if (!id) throw new Error('Storefront app card has no app id');
  if (!previewUrl) throw new Error(`Storefront app card ${id} has no preview URL on .app-cta`);
  return { id, previewUrl };
}

async function expectDetailPreview(page, { id, previewUrl }) {
  await page.goto(`https://freeappstore.online/apps/${id}`);
  await expect(page.locator('.app-split')).toBeVisible();
  await expect(page.locator('.app-split-info')).toBeVisible();
  await expect(page.locator('.app-split-phone')).toBeVisible();
  const iframe = page.locator('.phone-frame iframe');
  await expect(iframe).toBeVisible();
  await expect(iframe).toHaveAttribute('src', previewUrl);
  await expect(page.getByRole('heading', { name: 'Recent updates' })).toBeVisible();
}

test('an app detail page has the modern layout: split + phone-frame + history', async ({
  page,
}) => {
  // Pick whatever app is currently listed rather than hardcoding one —
  // apps get delisted (the old hardcoded `tip` now 404s), but the storefront
  // detail *template* is what we're actually testing. Take the id from the
  // card metadata rather than an inner link: cards may contain relative
  // quality-badge links before their app-launch CTA.
  //
  // Preview host comes from the card CTA (configured appUrl), not from
  // synthesizing `${id}.freeappstore.online` (#333).
  await page.goto('https://freeappstore.online');
  const { id, previewUrl } = await readCard(page.locator('.app-card').first());
  await expectDetailPreview(page, { id, previewUrl });
});

test('an ordinary app detail preview uses <app-id>.freeappstore.online', async ({ page }) => {
  await page.goto('https://freeappstore.online');
  const match = await page.evaluate(() => {
    for (const card of document.querySelectorAll('.app-card')) {
      const id = card.getAttribute('data-id');
      const href = card.querySelector('a.app-cta')?.getAttribute('href');
      if (!id || !href) continue;
      try {
        if (new URL(href).hostname === `${id}.freeappstore.online`) {
          return { id, previewUrl: href };
        }
      } catch {
        // skip malformed hrefs
      }
    }
    return null;
  });
  if (!match) {
    throw new Error(
      'No storefront card uses the standard <app-id>.freeappstore.online preview host',
    );
  }
  await expectDetailPreview(page, match);
});
