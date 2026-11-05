import { expect, test } from '@playwright/test';

test('editable form retains typing, validates, handles pending/rejected saves and returns focus', async ({
  page,
}) => {
  await page.route('https://api.freeappstore.online/**', (route) =>
    route.fulfill({ json: { value: null, friends: [], requests: [] } }),
  );
  await page.setViewportSize({ width: 320, height: 844 });
  await page.goto('/');
  const opener = page.getByRole('button', { name: 'Edit Example', exact: true });
  await expect(opener).toBeVisible();
  await page.evaluate(() => {
    document.documentElement.style.fontSize = '32px';
  });
  await page.getByRole('checkbox', { name: 'Pause saves' }).check();
  await opener.click();
  const dialog = page.getByRole('dialog', { name: 'Edit item' });
  const name = dialog.getByRole('textbox', { name: 'Name', exact: true });
  await expect(name).toBeFocused();
  await name.fill('');
  await name.pressSequentially('Longer name');
  await expect(name).toHaveValue('Longer name');
  await expect(name).toBeFocused();
  await page.keyboard.press('Shift+Tab');
  expect(await page.evaluate(() => !!document.activeElement?.closest('[role="dialog"]'))).toBe(
    true,
  );
  await page.keyboard.press('Tab');
  await expect(name).toBeFocused();
  expect(
    await name.evaluate((el) => {
      const rect = el.getBoundingClientRect();
      return rect.left >= 0 && rect.right <= innerWidth;
    }),
  ).toBe(true);
  await name.press('Enter');
  await expect(dialog.getByRole('status')).toHaveText('Saving…');
  await expect(dialog.getByRole('button', { name: 'Save', exact: true })).toBeDisabled();
  await page.keyboard.press('Escape');
  await expect(dialog).toBeVisible();
  await page.evaluate(() => window.dispatchEvent(new Event('resume-example-save')));
  await expect(dialog).toHaveCount(0);
  const updatedOpener = page.getByRole('button', { name: 'Edit Longer name', exact: true });
  await expect(updatedOpener).toBeFocused();
  await expect(page.getByRole('status', { name: 'Saved name' })).toHaveText('Longer name');

  await page.getByRole('checkbox', { name: 'Pause saves' }).uncheck();
  await page.getByRole('checkbox', { name: 'Simulate failed save' }).check();
  await updatedOpener.click();
  await expect(name).toHaveValue('Longer name');
  await name.fill('   ');
  await name.press('Enter');
  await expect(dialog.getByRole('alert')).toHaveText('Enter a name.');
  await name.fill('Keep my draft');
  await name.press('Enter');
  await expect(dialog.getByRole('alert')).toContainText('Your changes are still here');
  await expect(name).toHaveValue('Keep my draft');
  await expect(name).toBeFocused();
  await expect(page.getByRole('status', { name: 'Saved name' })).toHaveText('Longer name');
  await page.keyboard.press('Escape');
  await expect(updatedOpener).toBeFocused();
  await updatedOpener.click();
  await expect(name).toHaveValue('Longer name');
});
