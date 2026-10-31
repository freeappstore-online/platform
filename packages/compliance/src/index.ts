import { checkBrandFonts } from './checks/brand-fonts.js';
import { checkBrandTokens } from './checks/brand-tokens.js';
import { checkBundleSize } from './checks/bundle-size.js';
import { checkClaudeMdSlim } from './checks/claude-md-slim.js';
import { checkCssDiscipline } from './checks/css-discipline.js';
import { checkDarkMode } from './checks/dark-mode.js';
import { checkHtmlMeta } from './checks/html-meta.js';
import { checkLicenseMit } from './checks/license-mit.js';
import { checkManifest } from './checks/manifest.js';
import { checkNoAds } from './checks/no-ads.js';
import { checkNoBrandOverrides } from './checks/no-brand-overrides.js';
import { checkNoCommittedArtifacts } from './checks/no-committed-artifacts.js';
import { checkNoEnvProduction } from './checks/no-env-production.js';
import { checkNoExcessiveInlineStyles } from './checks/no-excessive-inline-styles.js';
import { checkNoPayments } from './checks/no-payments.js';
import { checkNoPlaceholders } from './checks/no-placeholders.js';
import { checkNoScroll } from './checks/no-scroll.js';
import { checkNoTracking } from './checks/no-tracking.js';
import { checkOpaqueSurface } from './checks/opaque-surface.js';
import { checkPermissions } from './checks/permissions.js';
import { checkMaskableIcon } from './checks/pwa-maskable-icon.js';
import { checkPwaMeta } from './checks/pwa-meta.js';
import { checkPwaOffline } from './checks/pwa-offline.js';
import { checkStoreLink } from './checks/store-link.js';
import { checkTextSelectable } from './checks/text-selectable.js';
import { checkUnsafeVh } from './checks/unsafe-vh.js';
import { checkViewportSupport } from './checks/viewport-support.js';
import { type FileSource, fsFileSource, mapFileSource } from './lib/file-source.js';
import { githubTreeSource } from './lib/github-tree-source.js';
import { isGameProject } from './lib/project-type.js';
import type { CheckResult } from './types.js';

export { INITIAL_LOAD_MAX_GZIP_BYTES, LAZY_ASSET_MAX_BYTES } from './lib/bundle-limits.js';
export type { FileSource } from './lib/file-source.js';
export { extractInlineManifest, type InlineManifest } from './lib/inline-manifest.js';
export type { DeclaredPermission, PermissionId } from './lib/permissions.js';
export {
  detectPermissions,
  PERMISSION_IDS,
  readDeclaredPermissions,
} from './lib/permissions.js';
export type { LiveAuditInput, LiveAuditReport } from './live/index.js';
// Live-URL audit (used by the compliance audit Worker; runs in
// browser/Workers env, no filesystem). Separate export path so callers
// don't accidentally pull node:fs in via the file-walking checks.
export {
  auditLive,
  checkBrandFontsLive,
  checkBundleSizeLive,
  checkManifestLive,
  checkNoAdsLive,
  checkNoTrackingLive,
  checkUnsafeVhLive,
} from './live/index.js';
export type { CheckResult, CheckStatus } from './types.js';
export {
  checkBrandFonts,
  checkBrandTokens,
  checkBundleSize,
  checkClaudeMdSlim,
  checkCssDiscipline,
  checkDarkMode,
  checkHtmlMeta,
  checkLicenseMit,
  checkManifest,
  checkMaskableIcon,
  checkNoAds,
  checkNoBrandOverrides,
  checkNoCommittedArtifacts,
  checkNoEnvProduction,
  checkNoExcessiveInlineStyles,
  checkNoPayments,
  checkNoPlaceholders,
  checkNoScroll,
  checkNoTracking,
  checkOpaqueSurface,
  checkPermissions,
  checkPwaMeta,
  checkPwaOffline,
  checkStoreLink,
  checkTextSelectable,
  checkUnsafeVh,
  checkViewportSupport,
  fsFileSource,
  githubTreeSource,
  isGameProject,
  mapFileSource,
};

/**
 * Runs every compliance check against the source. Two front doors:
 *   - `runChecks(repoDir)`        — CLI / CI; reads from disk.
 *   - `runChecksFromFiles(map)`   — VibeCode agent; reads from a Map.
 *
 * Both call the same underlying check functions via the FileSource
 * abstraction, so rules stay in one place. Results are returned in a
 * stable order so callers can render predictable output.
 */
export async function runChecks(repoDir: string): Promise<CheckResult[]> {
  return runChecksOn(fsFileSource(repoDir));
}

export async function runChecksFromFiles(files: Map<string, string>): Promise<CheckResult[]> {
  return runChecksOn(mapFileSource(files));
}

async function runChecksOn(source: FileSource): Promise<CheckResult[]> {
  return Promise.all([
    checkLicenseMit(source),
    checkNoCommittedArtifacts(source),
    checkNoEnvProduction(source),
    checkNoPlaceholders(source),
    checkNoTracking(source),
    checkNoPayments(source),
    checkNoAds(source),
    checkPermissions(source),
    checkBrandFonts(source),
    checkBrandTokens(source),
    checkNoBrandOverrides(source),
    checkNoScroll(source),
    checkViewportSupport(source),
    checkUnsafeVh(source),
    checkHtmlMeta(source),
    checkPwaMeta(source),
    checkPwaOffline(source),
    checkManifest(source),
    checkMaskableIcon(source),
    checkStoreLink(source),
    checkTextSelectable(source),
    checkDarkMode(source),
    checkCssDiscipline(source),
    checkNoExcessiveInlineStyles(source),
    checkOpaqueSurface(source),
    checkBundleSize(source),
    checkClaudeMdSlim(source),
  ]);
}
