import { checkNoPlaceholders } from './checks/no-placeholders.js';
import { checkNoTracking } from './checks/no-tracking.js';
import { checkBrandFonts } from './checks/brand-fonts.js';
import { checkManifest } from './checks/manifest.js';
import { checkBundleSize } from './checks/bundle-size.js';
import type { CheckResult } from './types.js';

export type { CheckStatus, CheckResult } from './types.js';
export {
  checkNoPlaceholders,
  checkNoTracking,
  checkBrandFonts,
  checkManifest,
  checkBundleSize,
};

/**
 * Runs every compliance check against `repoDir` (the root of an app, the
 * directory containing package.json + web/). Returns results in a stable
 * order so callers can render predictable output.
 */
export async function runChecks(repoDir: string): Promise<CheckResult[]> {
  return Promise.all([
    checkNoPlaceholders(repoDir),
    checkNoTracking(repoDir),
    checkBrandFonts(repoDir),
    checkManifest(repoDir),
    checkBundleSize(repoDir),
  ]);
}
