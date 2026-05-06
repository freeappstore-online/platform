import { test, expect } from '@playwright/test';

/**
 * Tests the mandarin-english phrase prep app's user-visible flows.
 * Includes regression coverage for the fullscreen gesture-timing bug
 * (request fired from useEffect was rejected on iOS Safari).
 *
 * Restricted to the desktop project: the Shell wrapper renders both
 * desktop and mobile DOM blocks (display-toggled by CSS), which trips
 * Playwright's strict-mode unique-match checks on most selectors.
 * Mobile-specific coverage will need a Shell that picks one tree per
 * viewport — out of scope here.
 */
const URL = 'https://mandarin-english.freeappstore.online';

test.beforeEach(async ({ page }, testInfo) => {
  // Shell renders dual desktop/mobile DOM trees; mobile selectors
  // collide with the hidden desktop tree. Desktop-only coverage for
  // now — out-of-scope to refactor Shell to single-tree.
  test.skip(
    testInfo.project.name === 'mobile',
    'Mandarin-english uses dual-tree Shell; selectors collide. Desktop only.',
  );
  // Every test starts with a clean localStorage so the seed phrases
  // load deterministically. This runs in an init script that fires
  // before the app's own JS, so the storage is wiped before useState
  // reads it.
  await page.addInitScript(() => {
    localStorage.clear();
  });
  await page.goto(URL);
});

test('app loads and shows seed phrases for English → Mandarin', async ({ page }) => {
  await expect(page.getByRole('heading', { name: 'Phrase prep' }).first()).toBeVisible();
  // Default pair is English → Mandarin. Use .first() throughout the
  // file because Shell renders desktop + mobile DOM trees; both
  // contain the same children. Desktop tree is first in DOM order, so
  // .first() consistently picks the visible one at this viewport.
  await expect(page.getByText('我来自悉尼').first()).toBeVisible();
});

test('add a phrase round-trips to the list', async ({ page }) => {
  // Switch to a fresh language pair so we don't have to disambiguate
  // among seed labels.
  await page.getByRole('button', { name: '+ Pair' }).first().click();
  await page.getByLabel('I speak').first().fill('English');
  await page.getByLabel("I'm practising").first().fill('Spanish');
  await page.getByRole('button', { name: 'Use this pair' }).first().click();

  // Scope the form fields by their containing <form> so we don't
  // collide with the duplicate mobile-tree form.
  const addForm = page.locator('form').first();
  await addForm.getByRole('textbox', { name: /Spanish.*what you'll say/ }).fill('¿Cómo estás?');
  await addForm.getByRole('textbox', { name: 'English meaning' }).fill('How are you?');
  await addForm.getByRole('button', { name: 'Add phrase' }).click();

  // It appears in the list (use .first() — phrase appears in both
  // desktop + mobile DOM trees).
  await expect(page.getByText('¿Cómo estás?').first()).toBeVisible();
  await expect(page.getByText('How are you?').first()).toBeVisible();
});

test('Practice tab shows step-through of phrases + Got it advances', async ({ page }) => {
  await page.getByRole('button', { name: 'Practice' }).first().click();
  // The current phrase is rendered large.
  await expect(page.getByText('1 / 2', { exact: false }).first()).toBeVisible();
  // Got it advances + marks practised.
  await page.getByRole('button', { name: 'Got it — next →' }).first().click();
  await expect(page.getByText('2 / 2', { exact: false }).first()).toBeVisible();
});

test('Full screen button exists and opens the modal', async ({ page }) => {
  // Regression coverage for the fullscreen gesture-timing bug:
  // the modal must be reachable from a real user click, and once
  // open the tap zones must be present.
  await page.getByRole('button', { name: 'Practice' }).first().click();
  await page.getByRole('button', { name: /Full screen/ }).first().click();
  // Modal is a single dialog, not duplicated by Shell — appended at
  // the body root via React's z-index modal.
  const dialog = page.getByRole('dialog', { name: 'Phrase fullscreen' });
  await expect(dialog).toBeVisible();
  await expect(page.getByRole('button', { name: 'Previous phrase' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Next phrase' })).toBeVisible();
  // Esc dismisses (matches keyboard handler).
  await page.keyboard.press('Escape');
  await expect(dialog).not.toBeVisible();
});
