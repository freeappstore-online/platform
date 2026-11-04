import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { expect, type Page, test } from '@playwright/test';

const connected = process.env.SCAFFOLD_TEMPLATE === 'connected';
const appFile = resolve(process.env.SCAFFOLD_DIR!, 'web/src/App.tsx');

test('fresh scaffold resolves a published SDK with profile fixes (#338)', async () => {
  // Read the installed package, not the declared range: pnpm can retain an
  // older release in a template lockfile even when a fixed release is on npm.
  const { version } = JSON.parse(
    await readFile(
      resolve(process.env.SCAFFOLD_DIR!, 'web/node_modules/@freeappstore/sdk/package.json'),
      'utf8',
    ),
  );
  const [major, minor, patch] = version.split('.').map(Number);
  expect(
    major > 0 || minor > 16 || (minor === 16 && patch >= 8),
    `Installed SDK ${version} predates the verified profile-navigation release; update the template lockfile`,
  ).toBe(true);
});

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

for (const theme of ['light', 'dark'] as const) {
  test(`compiled SDK floating surfaces and keyboard focus in ${theme} (#317)`, async ({
    page,
  }, testInfo) => {
    await page.emulateMedia({ colorScheme: theme, reducedMotion: 'reduce' });
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
    await landmarks(page);
    await page.evaluate(
      (value) => document.documentElement.setAttribute('data-theme', value),
      theme,
    );
    const skip = page.getByRole('link', { name: 'Skip to content' });
    expect((await skip.boundingBox())!.y).toBeLessThan(0);
    await page.keyboard.press('Tab');
    await expect(skip).toBeFocused();
    await expect.poll(async () => (await skip.boundingBox())!.y).toBeGreaterThanOrEqual(0);
    const menu = page.getByRole('button', { name: 'Menu', exact: true });
    if (testInfo.project.name === 'mobile') {
      await expect(menu).toBeVisible();
      await expect(page.locator('.fas-nav__list')).toBeHidden();
      await menu.click();
      const drawer = page.locator('.fas-nav__list');
      const bounds = (await drawer.boundingBox())!;
      expect(Math.round(bounds.x + bounds.width)).toBe(page.viewportSize()!.width);
      expect(bounds.height).toBeGreaterThan(page.viewportSize()!.height / 2);
      expect(
        await drawer.evaluate((el) => {
          const probe = document.createElement('div');
          probe.style.backgroundColor = 'var(--popover)';
          document.body.append(probe);
          const expected = getComputedStyle(probe).backgroundColor;
          probe.remove();
          return getComputedStyle(el).backgroundColor === expected;
        }),
      ).toBe(true);
      await expect(page.getByRole('link', { name: 'Profile', exact: true }).last()).toBeVisible();
      await page.keyboard.press('Escape');
      await expect(menu).toBeFocused();
      await expect(drawer).toBeHidden();
    } else {
      await expect(menu).toBeHidden();
      await expect(page.locator('.fas-nav__list')).toHaveCSS('display', 'flex');
    }
    await page.getByRole('link', { name: 'Profile', exact: true }).last().click();
    const profile = page
      .getByRole('button', { name: 'Manage API Keys', exact: true })
      .locator('..');
    const opaque = async (locator: typeof profile) =>
      locator.evaluate((el) => {
        const context = document.createElement('canvas').getContext('2d')!;
        context.fillStyle = getComputedStyle(el).backgroundColor;
        context.fillRect(0, 0, 1, 1);
        return context.getImageData(0, 0, 1, 1).data[3];
      });
    expect(await opaque(profile)).toBe(255);
    await page.getByRole('button', { name: 'Manage Friends', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: 'Friends' });
    await expect(dialog).toBeVisible();
    expect(await opaque(dialog)).toBe(255);
    await expect(dialog).toHaveCSS('border-style', 'solid');
    expect(await dialog.evaluate((el) => el.contains(document.activeElement))).toBe(true);
    await page.screenshot({ path: testInfo.outputPath(`sdk-${theme}.png`), fullPage: true });
    await page.keyboard.press('Escape');
    await expect(dialog).toBeHidden();
    expect(
      await page.locator('style#fas-nav-css, style#fas-shell-css, style#fas-ui-keyframes').count(),
    ).toBe(0);
  });

  test(`mobile menu is opaque over page text in ${theme} (#319)`, async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.emulateMedia({ colorScheme: theme });
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
    await expect(page.getByRole('main')).toBeVisible();
    await expect(page.getByRole('main')).not.toBeEmpty();
    await page.evaluate(
      (value) => document.documentElement.setAttribute('data-theme', value),
      theme,
    );
    await page.getByRole('button', { name: 'Menu', exact: true }).click();
    const list = page.locator('.fas-nav__list');
    await expect(list).toBeVisible();
    // Canvas resolves the browser's computed CSS color, including its alpha.
    const alpha = await list.evaluate((element) => {
      const canvas = document.createElement('canvas');
      canvas.width = canvas.height = 1;
      const context = canvas.getContext('2d')!;
      context.fillStyle = getComputedStyle(element).backgroundColor;
      context.fillRect(0, 0, 1, 1);
      return context.getImageData(0, 0, 1, 1).data[3] / 255;
    });
    expect(alpha).toBe(1);
  });
}

test('fresh scaffold: auth gate, landmarks, navigation and preferences', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto('/');
  if (connected) {
    await expect(page.getByText('Sign in to continue.', { exact: true })).toBeVisible();
    await expect(page.getByRole('link', { name: 'Open profile to sign in' })).toBeVisible();
    await expect(page.getByRole('main')).toBeVisible();
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
  // The standard Shell does not add platform attribution bars.
  await expect(page.getByRole('contentinfo')).toHaveCount(0);
  await page.keyboard.press('Tab');
  await expect(page.getByRole('link', { name: 'Skip to content' })).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(page.getByRole('main')).toBeFocused();
  await openMenu(page);
  const destination = connected ? 'Profile' : 'About';
  await page.getByRole('navigation').getByRole('link', { name: destination }).click();
  await expect(page).toHaveURL(connected ? /\/profile(?:\?|$)/ : /\/about$/);
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
    // Wait for React to commit the dismissal-reset effect before going offline again
    await expect(page.getByText(/You're offline/)).toHaveCount(0);
    await context.setOffline(true);
    await expect(page.getByText(/You're offline/)).toBeVisible();
    await context.setOffline(false);
    await expect(page.getByText(/You're offline/)).toHaveCount(0);
  } finally {
    await writeFile(appFile, original);
    await context.setOffline(false);
  }
});

for (const mode of ['ios', 'display-mode'] as const) {
  test(`installed app (${mode}) keeps the frame free of platform attribution bars`, async ({
    page,
  }) => {
    // Chromium cannot install a PWA in this context. Emulate the documented
    // installed-app signals, leaving the actual Shell and browser DOM intact.
    await page.addInitScript(
      ({ signedIn, mode }) => {
        if (mode === 'ios') Object.defineProperty(navigator, 'standalone', { value: true });
        else {
          const original = window.matchMedia.bind(window);
          window.matchMedia = (query) => {
            const result = original(query);
            if (query === '(display-mode: standalone)')
              Object.defineProperty(result, 'matches', { value: true });
            return result;
          };
        }
        if (signedIn)
          localStorage.setItem(
            'fas:session',
            JSON.stringify({
              token: 'browser-test-only',
              user: {
                id: 'gh:1',
                login: 'browser-test',
                avatarUrl: null,
                dateOfBirth: '2000-01-01',
              },
            }),
          );
      },
      { signedIn: connected, mode },
    );
    await page.goto('/');
    await landmarks(page);
    await expect(page.getByRole('contentinfo')).toHaveCount(0);
    await expect(page.getByRole('link', { name: 'Part of FreeAppStore' })).toHaveCount(0);
    const frame = page.getByRole('main').locator('..');
    await expect(frame).toHaveClass(/pb-\[env\(safe-area-inset-bottom,0px\)\]/);
    // Check the compiled Tailwind rule so a missing utility cannot pass
    // merely because desktop safe-area insets default to zero.
    const padding = await frame.evaluate((element) => {
      function findPadding(rules: CSSRuleList): string {
        for (const rule of rules) {
          if (
            rule instanceof CSSStyleRule &&
            element.matches(rule.selectorText) &&
            rule.style.paddingBottom.includes('safe-area-inset-bottom')
          )
            return rule.style.paddingBottom;
          if ('cssRules' in rule) {
            const nested = findPadding((rule as CSSGroupingRule).cssRules);
            if (nested) return nested;
          }
        }
        return '';
      }
      for (const sheet of document.styleSheets) {
        // External font stylesheets are not readable through CSSOM.
        if (sheet.href && new URL(sheet.href).origin !== location.origin) continue;
        const padding = findPadding(sheet.cssRules);
        if (padding) return padding;
      }
      return '';
    });
    expect(padding).toContain('env(safe-area-inset-bottom');
  });
}

test('published SDK still supports an explicitly chosen Footer (#332)', async ({
  page,
  request,
}) => {
  const original = await readFile(appFile, 'utf8');
  try {
    await writeFile(
      appFile,
      `import { Footer as OptInFooter } from '@freeappstore/sdk/ui'\n${original}`.replace(
        /(<Shell\b[^>]*>)/,
        '$1<OptInFooter text="App-chosen attribution" />',
      ),
    );
    await expect
      .poll(async () =>
        (await (await request.get('/src/App.tsx')).text()).includes('App-chosen attribution'),
      )
      .toBe(true);
    await page.addInitScript(() => {
      Object.defineProperty(navigator, 'standalone', { value: true });
      localStorage.setItem(
        'fas:session',
        JSON.stringify({
          token: 'browser-test-only',
          user: { id: 'gh:1', login: 'browser-test', avatarUrl: null, dateOfBirth: '2000-01-01' },
        }),
      );
    });
    await page.goto('/');
    await expect(page.locator('footer')).toHaveCount(1);
    await expect(page.getByRole('link', { name: 'App-chosen attribution' })).toBeVisible();
    await expect(page.getByRole('link', { name: 'Part of FreeAppStore' })).toHaveCount(0);
  } finally {
    await writeFile(appFile, original);
  }
});

for (const provider of ['github', 'google']) {
  test(`avatar opens profile before choosing ${provider}`, async ({ page }, testInfo) => {
    const starts: string[] = [];
    page.on('request', (request) => {
      if (/\/v1\/auth\/[^/]+\/start/.test(request.url())) starts.push(request.url());
    });
    await page.goto('/');
    const avatar = page
      .locator('header > div')
      .last()
      .getByRole('link', { name: 'Profile', exact: true });
    await expect(page.locator('header').getByRole('button', { name: /Sign in/ })).toHaveCount(0);
    await avatar.click();
    await expect(page).toHaveURL(/\/profile(?:\?|$)/);
    await expect(page.getByRole('heading', { name: 'Profile', exact: true })).toBeFocused();
    expect(starts).toEqual([]);
    if (provider === 'github')
      await page.screenshot({
        path: testInfo.outputPath('profile-signed-out.png'),
        fullPage: true,
      });
    await expect(page.getByRole('button', { name: 'Sign in with GitHub' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Sign in with Google' })).toBeVisible();
    await page.reload();
    await expect(page.getByRole('heading', { name: 'Profile', exact: true })).toBeVisible();
    await page.goBack();
    await expect(page).toHaveURL(/\/$/);
    await avatar.click();
    const request = page.waitForRequest((req) => req.url().includes(`/v1/auth/${provider}/start`));
    await page
      .getByRole('button', { name: `Sign in with ${provider === 'github' ? 'GitHub' : 'Google'}` })
      .click();
    const url = new URL((await request).url());
    expect(new URL(url.searchParams.get('return_to')!).pathname).toBe('/profile');
  });
}

test('signed-in avatar opens account page and sign-out keeps profile available', async ({
  page,
}) => {
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
  await page
    .locator('header > div')
    .last()
    .getByRole('link', { name: 'Profile', exact: true })
    .click();
  await expect(page).toHaveURL(/\/profile(?:\?|$)/);
  await expect(page.getByRole('main')).toContainText('browser-test');
  await page.getByRole('button', { name: 'Sign out', exact: true }).click();
  await expect(page).toHaveURL(/\/profile(?:\?|$)/);
  await expect(page.getByRole('button', { name: 'Sign in with Google' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Sign out', exact: true })).toHaveCount(0);
});

test('profile returns to the originating URL after reload and OAuth preserves it (#338)', async ({
  page,
}) => {
  await page.goto('/?view=recent#entry');
  await page.locator('header').getByRole('link', { name: 'Profile', exact: true }).last().click();
  await page.reload();
  await expect(page.getByRole('link', { name: 'Back to app' })).toHaveAttribute(
    'href',
    '/?view=recent#entry',
  );
  const request = page.waitForRequest((req) => req.url().includes('/v1/auth/github/start'));
  await page.getByRole('button', { name: 'Sign in with GitHub' }).click();
  const start = new URL((await request).url());
  const callback = new URL(start.searchParams.get('return_to')!);
  expect(callback.searchParams.get('returnTo')).toBe('/?view=recent#entry');
  await page.goto(callback.pathname + callback.search);
  await page.getByRole('link', { name: 'Back to app' }).click();
  await expect(page).toHaveURL(/\/\?view=recent#entry$/);
});
test('long account names fit narrow screens (#338)', async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 700 });
  await page.addInitScript(() =>
    localStorage.setItem(
      'fas:session',
      JSON.stringify({
        token: 'browser-test-only',
        user: { id: 'gh:1', login: 'a'.repeat(200), avatarUrl: null, dateOfBirth: '2000-01-01' },
      }),
    ),
  );
  await page.goto('/profile');
  await expect(page.getByText('a'.repeat(200), { exact: true })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(
    true,
  );
});

test('profile returns to the originating URL after reload and OAuth', async ({ page }) => {
  const origin = '/about?sort=recent#saved';
  await page.goto(origin);
  await page
    .locator('header > div')
    .last()
    .getByRole('link', { name: 'Profile', exact: true })
    .click();
  await expect(page.getByRole('heading', { name: 'Profile', exact: true })).toBeVisible();
  expect(new URL(page.url()).searchParams.get('returnTo')).toBe(origin);
  await page.reload();
  await expect(page.getByRole('link', { name: 'Back to app' })).toHaveAttribute('href', origin);
  await page.getByRole('link', { name: 'Back to app' }).click();
  await expect(page).toHaveURL(/\/about\?sort=recent#saved$/);
  if (!connected)
    await expect(page.getByRole('heading', { name: 'About', exact: true })).toBeVisible();
  await page
    .locator('header > div')
    .last()
    .getByRole('link', { name: 'Profile', exact: true })
    .click();
  const request = page.waitForRequest((req) => req.url().includes('/v1/auth/google/start'));
  await page.getByRole('button', { name: 'Sign in with Google' }).click();
  const oauth = new URL((await request).url());
  const callback = new URL(oauth.searchParams.get('return_to')!);
  expect(callback.searchParams.get('returnTo')).toBe(origin);
});

test('profile contains long names and keyboard navigation closes the drawer', async ({ page }) => {
  const login = 'a'.repeat(39);
  await page.setViewportSize({ width: 320, height: 800 });
  await page.addInitScript(
    (login) =>
      localStorage.setItem(
        'fas:session',
        JSON.stringify({
          token: 'browser-test-only',
          user: { id: 'gh:1', login, avatarUrl: null, dateOfBirth: '2000-01-01' },
        }),
      ),
    login,
  );
  await page.goto('/');
  const menu = page.getByRole('button', { name: 'Menu', exact: true });
  await menu.click();
  const avatar = page
    .locator('header > div')
    .last()
    .getByRole('link', { name: 'Profile', exact: true });
  await avatar.focus();
  await page.keyboard.press('Enter');
  await expect(menu).toHaveAttribute('aria-expanded', 'false');
  await expect(page.getByRole('heading', { name: 'Profile', exact: true })).toBeFocused();
  const name = page.getByText(login, { exact: true });
  await expect(name).toBeVisible();
  const right = await name.evaluate((el) => {
    const range = document.createRange();
    range.selectNodeContents(el);
    return Math.max(...Array.from(range.getClientRects()).map((rect) => rect.right));
  });
  expect(right).toBeLessThanOrEqual(320);
});

test('profile without a router preserves native navigation and browser scroll ownership', async ({
  page,
}) => {
  const original = await readFile(appFile, 'utf8');
  await page.addInitScript(() =>
    localStorage.setItem(
      'fas:session',
      JSON.stringify({
        token: 'browser-test-only',
        user: { id: 'gh:1', login: 'browser-test', avatarUrl: null, dateOfBirth: '2000-01-01' },
      }),
    ),
  );
  try {
    await writeFile(appFile, original.replace('onNavigate={navigate}', ''));
    // Wait for the edited module before loading the page. Reloading a stale
    // router module can retain its manual scroll mode in the history entry.
    await expect
      .poll(async () => (await page.request.get('/src/App.tsx')).text())
      .not.toMatch(/onNavigate:\s*navigate/);
    await page.goto('/');
    await expect(page.locator('header')).toBeVisible();
    expect(await page.evaluate(() => history.scrollRestoration)).toBe('auto');
    await page.evaluate(() => {
      document.documentElement.dataset.nativeProbe = 'before';
    });
    await page
      .locator('header > div')
      .last()
      .getByRole('link', { name: 'Profile', exact: true })
      .click();
    await expect(page.getByRole('heading', { name: 'Profile', exact: true })).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.dataset.nativeProbe)).toBeUndefined();
    expect(await page.evaluate(() => history.scrollRestoration)).toBe('auto');
    await page.goBack();
    await expect(page.getByRole('main')).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Profile', exact: true })).toHaveCount(0);
    expect(await page.evaluate(() => history.scrollRestoration)).toBe('auto');
  } finally {
    await writeFile(appFile, original);
  }
});
