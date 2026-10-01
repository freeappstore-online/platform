import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { expect, type Page, test } from '@playwright/test';

const connected = process.env.SCAFFOLD_TEMPLATE === 'connected';
const appFile = resolve(process.env.SCAFFOLD_DIR!, 'web/src/App.tsx');

async function openMenu(page: Page) {
  const menu = page.getByRole('button', { name: 'Menu', exact: true });
  if (await menu.isVisible()) await menu.click();
}

async function landmarks(page: Page) {
  for (const role of ['banner', 'navigation', 'main'] as const) {
    await expect(page.getByRole(role)).toBeVisible();
  }
}

test.beforeEach(async ({ page }) => {
  // Deterministic backend responses: exercise the real SDK and UI without OAuth
  // credentials, production data, or external service availability.
  await page.route('https://api.freeappstore.online/**', async (route) => {
    if (new URL(route.request().url()).pathname === '/v1/analytics.js') {
      await route.fulfill({ contentType: 'application/javascript', body: '' });
    } else {
      await route.fulfill({ json: { value: null, friends: [], requests: [] } });
    }
  });
});

test('fresh scaffold: auth gate, landmarks, navigation and preferences', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto('/');
  if (connected) {
    await expect(page.getByText('Sign in to continue.', { exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: /Sign in/ })).toBeVisible();
    await expect(page.getByRole('main')).toHaveCount(0);
    await page.evaluate(() =>
      localStorage.setItem(
        'fas:session',
        JSON.stringify({
          token: 'browser-test-only',
          user: { id: 'gh:1', login: 'browser-test', avatarUrl: null, dateOfBirth: '2000-01-01' },
        }),
      ),
    );
    await page.reload();
  }
  await landmarks(page);
  // Footer is intentionally installed-PWA-only; ordinary browser tabs omit it.
  await expect(page.getByRole('contentinfo')).toHaveCount(0);
  await page.keyboard.press('Tab');
  await expect(page.getByRole('link', { name: 'Skip to content' })).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(page.getByRole('main')).toBeFocused();
  await openMenu(page);
  const destination = connected ? 'Account' : 'About';
  await page.getByRole('navigation').getByRole('link', { name: destination }).click();
  await expect(page).toHaveURL(connected ? /\/account$/ : /\/about$/);
  await expect(
    page.getByRole('main').getByRole('heading', { name: destination, exact: true }),
  ).toBeFocused();
  await openMenu(page);
  await expect(
    page.getByRole('navigation').getByRole('link', { name: destination }),
  ).toHaveAttribute('aria-current', 'page');
  const menu = page.getByRole('button', { name: 'Menu', exact: true });
  if (await menu.isVisible()) {
    await page.keyboard.press('Escape');
    await expect(menu).toHaveAttribute('aria-expanded', 'false');
    await expect(menu).toBeFocused();
    await expect(menu).toHaveCSS('outline-style', 'solid');
  }
  const lightPanel = await page
    .locator('header')
    .evaluate((el) => getComputedStyle(el).backgroundColor);
  if (connected) {
    await page.getByRole('button', { name: 'Dark', exact: true }).click();
  } else {
    await page.getByRole('button', { name: 'Theme: system', exact: true }).click();
    await page.getByRole('button', { name: 'Theme: light', exact: true }).click();
  }
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  const originalSize = await page.locator('html').evaluate((el) => getComputedStyle(el).fontSize);
  await page.getByRole('button', { name: 'Text: default', exact: true }).click();
  await expect(page.locator('html')).toHaveAttribute('data-text', 'lg');
  await expect
    .poll(() => page.locator('html').evaluate((el) => getComputedStyle(el).fontSize))
    .not.toBe(originalSize);
  await page.reload();
  await landmarks(page);
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  await expect(page.locator('html')).toHaveAttribute('data-text', 'lg');
  await expect
    .poll(() => page.locator('header').evaluate((el) => getComputedStyle(el).backgroundColor))
    .not.toBe(lightPanel);
  expect(errors).toEqual([]);
});

test('Shell resilience: render failure/retry, toast and browser offline events', async ({
  page,
  context,
  request,
}) => {
  // Add controls only to the disposable scaffold, inside its existing Shell.
  // Do not replace the Shell, SDK, navigation, or default screen under test.
  const original = await readFile(appFile, 'utf8');
  const instrumented =
    `import { useToast as useBrowserToast } from '@freeappstore/sdk/ui'\n${original}`.replace(
      /(<Shell\b[^>]*>)/,
      '$1<BrowserProbe />',
    ) +
    `
function BrowserProbe() {
  const toast = useBrowserToast()
  const [broken, setBroken] = useState(false)
  if (broken && sessionStorage.getItem('browser-crash') === 'yes') {
    throw new Error('Intentional browser resilience probe')
  }
  return <div>
    <button onClick={() => { sessionStorage.setItem('browser-crash', 'yes'); setBroken(true) }}>Break screen</button>
    <button onClick={() => toast.show('Browser toast', { duration: 0 })}>Show toast</button>
    <button onClick={() => toast.show('Timed toast', { duration: 500 })}>Timed toast</button>
  </div>
}
`;
  try {
    await writeFile(appFile, instrumented);
    // Wait for Vite to observe the temporary edit before loading its cached module.
    await expect
      .poll(async () =>
        (await (await request.get('/src/App.tsx')).text()).includes('function BrowserProbe'),
      )
      .toBe(true);
    if (connected)
      await page.addInitScript(() =>
        localStorage.setItem(
          'fas:session',
          JSON.stringify({
            token: 'browser-test-only',
            user: { id: 'gh:1', login: 'browser-test', avatarUrl: null, dateOfBirth: '2000-01-01' },
          }),
        ),
      );
    await page.goto('/');
    await page.getByRole('button', { name: 'Break screen' }).click();
    await expect(page.getByRole('alert')).toContainText('Something went wrong');
    await landmarks(page);
    await page.evaluate(() => sessionStorage.removeItem('browser-crash'));
    await page.getByRole('button', { name: 'Try again', exact: true }).click();
    await expect(page.getByRole('alert')).toHaveCount(0);
    await page.getByRole('button', { name: 'Show toast', exact: true }).click();
    await expect(page.locator('.fas-toast-region')).toHaveAttribute('aria-live', 'polite');
    await expect(page.locator('.fas-toast')).toHaveText('Browser toast×');
    await page.locator('.fas-toast').getByRole('button', { name: 'Dismiss', exact: true }).click();
    await expect(page.locator('.fas-toast')).toHaveCount(0);
    await page.getByRole('button', { name: 'Timed toast', exact: true }).click();
    await expect(page.locator('.fas-toast')).toContainText('Timed toast');
    await expect(page.locator('.fas-toast')).toHaveCount(0);
    await context.setOffline(true);
    await expect(page.getByText(/You're offline/)).toBeVisible();
    await page.getByRole('button', { name: 'Dismiss offline notice' }).click();
    await expect(page.getByText(/You're offline/)).toHaveCount(0);
    await context.setOffline(false);
    await expect.poll(() => page.evaluate(() => navigator.onLine)).toBe(true);
    await context.setOffline(true);
    await expect(page.getByText(/You're offline/)).toBeVisible();
    await context.setOffline(false);
    await expect(page.getByText(/You're offline/)).toHaveCount(0);
  } finally {
    await writeFile(appFile, original);
    await context.setOffline(false);
  }
});

test('installed app exposes the footer landmark', async ({ page }) => {
  // Chromium cannot install a PWA in this context. Emulate the documented
  // iOS installed-app flag, leaving the actual Footer and browser DOM intact.
  await page.addInitScript((signedIn) => {
    Object.defineProperty(navigator, 'standalone', { value: true });
    if (signedIn)
      localStorage.setItem(
        'fas:session',
        JSON.stringify({
          token: 'browser-test-only',
          user: { id: 'gh:1', login: 'browser-test', avatarUrl: null, dateOfBirth: '2000-01-01' },
        }),
      );
  }, connected);
  await page.goto('/');
  await landmarks(page);
  await expect(page.getByRole('contentinfo')).toBeVisible();
  await expect(
    page.getByRole('contentinfo').getByRole('link', { name: 'Part of FreeAppStore' }),
  ).toHaveAttribute('href', 'https://freeappstore.online');
});
