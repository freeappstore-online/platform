import { type ElectronApplication, expect, type Page } from '@playwright/test';

/**
 * The home window. Not `firstWindow()`: with a connected account the hidden Contribute window
 * (contribute.html) opens right after it and can be reported first, as it was on CI (#851).
 */
export async function homeWindow(electron: ElectronApplication): Promise<Page> {
  let home: Page | undefined;
  await expect
    .poll(() => {
      home = electron.windows().find((w) => w.url().endsWith('/renderer/index.html'));
      return Boolean(home);
    })
    .toBe(true);
  return home!;
}
