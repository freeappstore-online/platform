/**
 * Live-URL audit checks. Unlike the file-walking checks in ../checks/,
 * these run inside a Cloudflare Worker (no filesystem) against published
 * apps' live URLs to catch post-publish drift.
 *
 * What we can check from a live URL:
 *   - Tracking SDK injection (script src, inline scripts, fetched JS)
 *   - Ad network tags (script src, inline scripts) — FreeAppStore apps show no ads
 *   - Brand fonts presence (link href to fonts.googleapis.com)
 *   - PWA manifest reachable + valid
 *   - Initial-load JS size (entry script + modulepreload chunks)
 *
 * What we CAN'T check post-publish:
 *   - APPNAME placeholders (build erases these)
 *   - Brand-override CSS variables (sourcemaps not always shipped)
 *
 * The audit Worker runs these on a weekly cron and stores per-app
 * results in D1 so creators (or platform admins) can see drift over
 * time without leaving the storefront.
 */

import { matchAdNetworks, NO_ADS_SUGGESTIONS } from '../checks/no-ads.js';
import { INITIAL_LOAD_MAX_GZIP_BYTES } from '../lib/bundle-limits.js';
import { gzipByteLength } from '../lib/gzip.js';
import { collectInitialJsRefs, jsAssetFileName } from '../lib/html-initial-js.js';
import { stripHtmlComments } from '../lib/strip.js';
import type { CheckResult } from '../types.js';

/** Cap live fetches of the initial graph so a page with many modulepreloads
 *  cannot blow the Worker subrequest budget. 6 is well above a typical
 *  Vite split (entry + 1–2 vendors). */
const MAX_LIVE_INITIAL_FETCHES = 6;

const TRACKER_PATTERNS = [
  /google-analytics\.com/i,
  /gtag\(/i,
  /googletagmanager\.com/i,
  /\bamplitude\b/i,
  /\bmixpanel\b/i,
  /\bsegment\.com\b/i,
  /\bhotjar\.com\b/i,
  /plausible\.io/i,
  /posthog\.com/i,
];

export interface LiveAuditInput {
  appId: string;
  liveUrl: string; // e.g. https://tip.freeappstore.online
}

export interface LiveAuditReport {
  appId: string;
  liveUrl: string;
  checkedAt: number;
  reachable: boolean;
  results: CheckResult[];
}

/**
 * Fetch with a timeout — Workers' default fetch waits 30s+, too slow
 * when iterating 50+ apps in one cron tick.
 */
async function fetchWithTimeout(url: string, ms = 8000): Promise<Response> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ms);
  try {
    return await fetch(url, { signal: ctrl.signal, redirect: 'follow' });
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Worker subrequest cap errors look like "Too many subrequests by
 * single Worker invocation." We don't want to record those as "fail"
 * verdicts because the app isn't actually broken — the audit just
 * couldn't check. Detect and flag for the caller.
 */
function isSubrequestCapError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return /too many subrequests|subrequest.*limit/i.test(msg);
}

export async function auditLive(input: LiveAuditInput): Promise<LiveAuditReport> {
  const checkedAt = Date.now();
  const report: LiveAuditReport = {
    appId: input.appId,
    liveUrl: input.liveUrl,
    checkedAt,
    reachable: false,
    results: [],
  };

  let html: string;
  try {
    const res = await fetchWithTimeout(input.liveUrl);
    if (!res.ok) {
      report.results.push({
        name: 'Reachable',
        status: 'fail',
        detail: `HTTP ${res.status} from ${input.liveUrl}`,
      });
      return report;
    }
    html = await res.text();
    report.reachable = true;
    // Always record a Reachable row on success — otherwise stale
    // "Reachable: fail" rows from previous failed runs (e.g.
    // subrequest-cap noise) never get overwritten, because the
    // upsert is keyed on (app_id, check_name).
    report.results.push({
      name: 'Reachable',
      status: 'pass',
      detail: `${input.liveUrl} → HTTP ${res.status}`,
    });
  } catch (err) {
    // Subrequest cap means we couldn't even fetch — that's a "warn"
    // (re-check needed), not a "fail" (app broken). Distinguishing
    // matters: failures show red badges in the storefront.
    const skipped = isSubrequestCapError(err);
    report.results.push({
      name: 'Reachable',
      status: skipped ? 'warn' : 'fail',
      detail: skipped
        ? 'audit Worker hit subrequest cap — re-run needed'
        : err instanceof Error
          ? err.message
          : 'fetch failed',
    });
    return report;
  }

  // Run all checks in parallel — each is independent.
  const [tracking, ads, fonts, manifest, bundle, vh] = await Promise.all([
    checkNoTrackingLive(html),
    checkNoAdsLive(html),
    checkBrandFontsLive(html),
    checkManifestLive(html, input.liveUrl),
    checkBundleSizeLive(html, input.liveUrl),
    checkUnsafeVhLive(html, input.liveUrl),
  ]);
  report.results.push(tracking, ads, fonts, manifest, bundle, vh);
  return report;
}

export function checkNoTrackingLive(html: string): CheckResult {
  const found = TRACKER_PATTERNS.filter((re) => re.test(html));
  if (found.length === 0) {
    return {
      name: 'Analytics routed through platform loader (live)',
      status: 'pass',
      detail: 'no direct tracker SDKs detected in live HTML',
    };
  }
  return {
    name: 'Analytics routed through platform loader (live)',
    status: 'fail',
    detail: `${found.length} direct-tracker pattern${found.length === 1 ? '' : 's'} matched`,
    suggestions: [
      'Replace the direct SDK with the platform loader: <script src="https://api.freeappstore.online/v1/analytics.js?app=<id>" defer></script>.',
      'Configure providers via PUT /v1/apps/<id>/analytics so policy can evolve without a redeploy.',
    ],
  };
}

/**
 * Live counterpart to checkNoAds: the same ad-network patterns, run over the
 * served HTML with HTML comments stripped. Catches the classic pasted ad tag
 * (`<script async src="https://pagead2.googlesyndication.com/…">`, an inline
 * `adsbygoogle.push`); an ad SDK bundled into the JS is the source check's job.
 */
export function checkNoAdsLive(html: string): CheckResult {
  const found = matchAdNetworks(stripHtmlComments(html));
  if (found.length === 0) {
    return { name: 'No ads (live)', status: 'pass', detail: 'no ad network tags in live HTML' };
  }
  return {
    name: 'No ads (live)',
    status: 'fail',
    detail: `ad network tags in live HTML: ${found.join(', ')}`,
    suggestions: NO_ADS_SUGGESTIONS,
  };
}

export function checkBrandFontsLive(html: string): CheckResult {
  const hasManrope = /manrope/i.test(html);
  const hasFraunces = /fraunces/i.test(html);
  if (hasManrope && hasFraunces) {
    return { name: 'Brand fonts (live)', status: 'pass', detail: 'Manrope + Fraunces referenced' };
  }
  const missing: string[] = [];
  if (!hasManrope) missing.push('Manrope');
  if (!hasFraunces) missing.push('Fraunces');
  return {
    name: 'Brand fonts (live)',
    status: 'fail',
    detail: `missing: ${missing.join(', ')}`,
    suggestions: ['Restore the Google Fonts <link> in web/index.html.'],
  };
}

export async function checkManifestLive(html: string, liveUrl: string): Promise<CheckResult> {
  // Find the manifest link in the HTML, then fetch + validate it.
  // rel and href can appear in either order (same as checkUnsafeVhLive).
  const m =
    /<link[^>]*rel=["']manifest["'][^>]*href=["']([^"']+)["']/i.exec(html) ??
    /<link[^>]*href=["']([^"']+)["'][^>]*rel=["']manifest["']/i.exec(html);
  if (!m) {
    return {
      name: 'PWA manifest (live)',
      status: 'fail',
      detail: 'no <link rel="manifest"> in HTML',
    };
  }
  const href = m[1]!;
  const manifestUrl = new URL(href, liveUrl).toString();
  try {
    const res = await fetchWithTimeout(manifestUrl);
    if (!res.ok) {
      return {
        name: 'PWA manifest (live)',
        status: 'fail',
        detail: `${manifestUrl} → HTTP ${res.status}`,
      };
    }
    const body = (await res.json()) as { name?: string; display?: string; start_url?: string };
    const missing: string[] = [];
    if (!body.name) missing.push('name');
    if (!body.display) missing.push('display');
    if (!body.start_url) missing.push('start_url');
    if (missing.length > 0) {
      return {
        name: 'PWA manifest (live)',
        status: 'fail',
        detail: `manifest missing fields: ${missing.join(', ')}`,
      };
    }
    return { name: 'PWA manifest (live)', status: 'pass', detail: manifestUrl };
  } catch (err) {
    const skipped = isSubrequestCapError(err);
    return {
      name: 'PWA manifest (live)',
      status: skipped ? 'warn' : 'fail',
      detail: skipped
        ? 'audit Worker hit subrequest cap — re-run needed'
        : err instanceof Error
          ? err.message
          : 'manifest fetch/parse failed',
    };
  }
}

export async function checkBundleSizeLive(html: string, liveUrl: string): Promise<CheckResult> {
  // Same initial-load graph the source-side check uses: <script src>
  // plus <link rel="modulepreload">. Dynamic chunks are not in the HTML,
  // so a large lazy worker/wasm cannot fail the live 300 KB cap.
  const assetRefs = collectInitialJsRefs(html).filter((r) => jsAssetFileName(r) !== null);
  if (assetRefs.length === 0) {
    // Plausible miss for non-Vite apps — not a fail, just skip.
    return {
      name: 'Bundle size (live)',
      status: 'warn',
      detail: 'no /assets/*.js found — non-Vite layout?',
    };
  }

  let largestName = '';
  let largestGzip = 0;
  let largestRaw = 0;
  try {
    for (const ref of assetRefs.slice(0, MAX_LIVE_INITIAL_FETCHES)) {
      const jsUrl = new URL(ref, liveUrl).toString();
      const res = await fetchWithTimeout(jsUrl);
      if (!res.ok) {
        return { name: 'Bundle size (live)', status: 'fail', detail: `${jsUrl} → ${res.status}` };
      }
      const body = await res.arrayBuffer();
      // Real gzip via the shared helper — same math the source-side
      // check uses, so live and source verdicts can never disagree on
      // a borderline app.
      const gzippedBytes = await gzipByteLength(new Uint8Array(body));
      if (gzippedBytes > largestGzip) {
        largestGzip = gzippedBytes;
        largestRaw = body.byteLength;
        largestName = jsAssetFileName(ref) ?? ref;
      }
    }
  } catch (err) {
    const skipped = isSubrequestCapError(err);
    return {
      name: 'Bundle size (live)',
      status: 'warn',
      detail: skipped
        ? 'audit Worker hit subrequest cap — re-run needed'
        : err instanceof Error
          ? err.message
          : 'bundle fetch failed',
    };
  }

  const gzipKb = Math.round(largestGzip / 1024);
  const rawKb = Math.round(largestRaw / 1024);
  const limitKb = Math.round(INITIAL_LOAD_MAX_GZIP_BYTES / 1024);
  if (largestGzip > INITIAL_LOAD_MAX_GZIP_BYTES) {
    return {
      name: 'Bundle size (live)',
      status: 'fail',
      detail: `${largestName}: ${gzipKb} KB gzipped (raw ${rawKb} KB) — over ${limitKb} KB limit`,
    };
  }
  return {
    name: 'Bundle size (live)',
    status: 'pass',
    detail: `${largestName}: ${gzipKb} KB gzipped (raw ${rawKb} KB)`,
  };
}

/**
 * Live counterpart to checkUnsafeVh. Fetches the first bundled
 * stylesheet linked from the HTML and scans it for `100vh` (the
 * unit, not the Tailwind class — by build time those have been
 * compiled to CSS). Catches whiteboard-class iOS Safari URL-bar
 * scroll bugs in apps that have already shipped.
 *
 * Cost: one extra subrequest per app. The audit Worker runs near the
 * free-plan subrequest cap; on cap errors we degrade to `warn`
 * (re-run needed) rather than `fail` (app broken) — the app isn't
 * actually broken, the audit just couldn't check.
 */
export async function checkUnsafeVhLive(html: string, liveUrl: string): Promise<CheckResult> {
  // Find the first bundled stylesheet. Vite output looks like
  // <link rel="stylesheet" href="/assets/index-XYZ.css">. Be
  // tolerant of attribute order — rel and href can appear either way.
  const m =
    /<link[^>]+rel=["']stylesheet["'][^>]*href=["']([^"']+\.css[^"']*)["']/i.exec(html) ??
    /<link[^>]+href=["']([^"']+\.css[^"']*)["'][^>]*rel=["']stylesheet["']/i.exec(html);
  if (!m) {
    // No stylesheet link — could be inline-only styles, or styles
    // injected at runtime. Not a fail; just nothing to check.
    return {
      name: 'No unsafe 100vh (live)',
      status: 'warn',
      detail: 'no <link rel="stylesheet"> found in HTML — skipped',
    };
  }
  const cssUrl = new URL(m[1]!, liveUrl).toString();
  try {
    const res = await fetchWithTimeout(cssUrl);
    if (!res.ok) {
      return {
        name: 'No unsafe 100vh (live)',
        status: 'warn',
        detail: `${cssUrl} → HTTP ${res.status}`,
      };
    }
    const css = await res.text();
    const matches = css.match(/\b100vh\b/g) ?? [];
    if (matches.length === 0) {
      return { name: 'No unsafe 100vh (live)', status: 'pass', detail: `scanned ${cssUrl}` };
    }
    return {
      name: 'No unsafe 100vh (live)',
      status: 'warn',
      detail: `${matches.length} occurrence(s) of 100vh in ${cssUrl}`,
      suggestions: [
        '100vh resolves to the layout viewport on iOS Safari — when the URL bar is visible the page scrolls.',
        'Replace with 100svh (small viewport — accounts for visible browser UI) or 100dvh (dynamic — recomputes as URL bar moves).',
      ],
    };
  } catch (err) {
    const skipped = isSubrequestCapError(err);
    return {
      name: 'No unsafe 100vh (live)',
      status: 'warn',
      detail: skipped
        ? 'audit Worker hit subrequest cap — re-run needed'
        : err instanceof Error
          ? err.message
          : 'CSS fetch failed',
    };
  }
}
