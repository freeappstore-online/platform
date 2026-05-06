import { checkNoPlaceholders } from './checks/no-placeholders.js';
import { checkNoTracking } from './checks/no-tracking.js';
import { checkBrandFonts } from './checks/brand-fonts.js';
import { checkNoBrandOverrides } from './checks/no-brand-overrides.js';
import { checkNoScroll } from './checks/no-scroll.js';
import { checkManifest } from './checks/manifest.js';
import { checkBundleSize } from './checks/bundle-size.js';
import type { CheckResult } from './types.js';

export type { CheckStatus, CheckResult } from './types.js';
export {
  checkNoPlaceholders,
  checkNoTracking,
  checkBrandFonts,
  checkNoBrandOverrides,
  checkNoScroll,
  checkManifest,
  checkBundleSize,
};

// Live-URL audit (used by the compliance audit Worker; runs in
// browser/Workers env, no filesystem). Separate export path so callers
// don't accidentally pull node:fs in via the file-walking checks.
export {
  auditLive,
  checkNoTrackingLive,
  checkBrandFontsLive,
  checkManifestLive,
  checkBundleSizeLive,
} from './live/index.js';
export type { LiveAuditInput, LiveAuditReport } from './live/index.js';

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
    checkNoBrandOverrides(repoDir),
    checkNoScroll(repoDir),
    checkManifest(repoDir),
    checkBundleSize(repoDir),
  ]);
}
