import { readFileSync } from 'node:fs';
import { expect, type Page, test } from '@playwright/test';

// The storefront shares this repo's existing browser test harness; no production dependency is added.
const asset = (name: string) =>
  readFileSync(new URL(`../../sites/storefront/${name}`, import.meta.url));
async function setup(page: Page) {
  await page.route('**/*', async (route) => {
    const url = new URL(route.request().url());
    if (url.hostname !== 'shortcuts.test') return route.abort();
    if (url.pathname === '/quick-access.js')
      return route.fulfill({ body: asset('quick-access.js'), contentType: 'text/javascript' });
    if (url.pathname === '/style.css')
      return route.fulfill({ body: asset('style.css'), contentType: 'text/css' });
    return route.fulfill({
      contentType: 'text/html',
      body: `<!doctype html><html><head><meta name="viewport" content="width=device-width, initial-scale=1"><link rel="stylesheet" href="/style.css"></head><body><main class="container">
      <section id="quick-access" aria-label="Quick access"></section><div class="apps-grid compact" id="apps-grid">
      ${['books', 'notes'].map((id) => `<div class="app-card compact" role="button" tabindex="0" data-id="${id}" data-name="${id}"><div class="app-icon"><span class="app-emoji">📚</span></div><div class="app-body"><span class="app-name">${id}</span></div><button class="vote-btn">Vote</button><a class="app-cta" href="https://${id}.freeappstore.online/" target="_blank" rel="noopener">Open</a></div>`).join('')}
      </div></main><script>window.cardClicks=0;document.querySelectorAll('.app-card').forEach(c=>c.addEventListener('click',()=>window.cardClicks++));</script><script src="/quick-access.js"></script></body></html>`,
    });
  });
  await page.goto('https://shortcuts.test/');
}

test('website stars persist, keyboard controls do not activate cards, and clearing recent keeps favourites', async ({
  page,
}) => {
  await setup(page);
  const card = page.locator('.app-card[data-id="books"]');
  await card.getByRole('button', { name: 'Favourite books' }).focus();
  await page.keyboard.press('Enter');
  await expect(card.getByRole('button', { name: 'Unfavourite books' })).toHaveAttribute(
    'aria-pressed',
    'true',
  );
  await expect(card.getByRole('button', { name: 'Unfavourite books' })).toBeFocused();
  expect(await page.evaluate(() => Reflect.get(window, 'cardClicks'))).toBe(0);
  await page.reload();
  await expect(
    page.getByRole('region', { name: 'Quick access' }).getByRole('link', { name: 'Open books' }),
  ).toBeVisible();
  const popup = page.waitForEvent('popup');
  await page.locator('.app-card[data-id="notes"] .app-cta').click();
  await (await popup).close();
  const quick = page.getByRole('region', { name: 'Quick access' });
  await expect(quick.getByRole('heading', { name: 'Recently used' })).toBeVisible();
  await expect(quick.getByRole('link', { name: 'Open notes' })).toBeVisible();
  await quick.getByRole('button', { name: 'Clear recently used' }).click();
  await expect(quick.getByRole('link', { name: 'Open notes' })).toHaveCount(0);
  await expect(quick.getByRole('link', { name: 'Open books' })).toBeVisible();
  await quick.getByRole('button', { name: 'Unfavourite books' }).click();
  await expect(quick.getByRole('link', { name: 'Open books' })).toHaveCount(0);
});

for (const width of [360, 420, 1100]) {
  test(`website quick access wraps at ${width}px with enlarged text`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    await setup(page);
    await page.getByRole('button', { name: 'Favourite books', exact: true }).click();
    await page.addStyleTag({ content: ':root, body { font-size: 24px !important; }' });
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= document.documentElement.clientWidth,
      ),
    ).toBe(true);
    await expect(
      page.getByRole('region', { name: 'Quick access' }).getByRole('link', { name: 'Open books' }),
    ).toBeVisible();
  });
}
