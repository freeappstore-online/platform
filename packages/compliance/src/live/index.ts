/**
 * Live-URL audit checks. Unlike the file-walking checks in ../checks/,
 * these run inside a Cloudflare Worker (no filesystem) against published
 * apps' live URLs to catch post-publish drift.
 *
 * What we can check from a live URL:
 *   - Tracking SDK injection (script src, inline scripts, fetched JS)
 *   - Brand fonts presence (link href to fonts.googleapis.com)
 *   - PWA manifest reachable + valid
 *   - Main bundle size (HEAD request)
 *
 * What we CAN'T check post-publish:
 *   - APPNAME placeholders (build erases these)
 *   - Brand-override CSS variables (sourcemaps not always shipped)
 *
 * The audit Worker runs these on a weekly cron and stores per-app
 * results in D1 so creators (or platform admins) can see drift over
 * time without leaving the storefront.
 */

import type { CheckResult } from '../types.js';

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

  // Run the four checks in parallel — each is independent.
  const [tracking, fonts, manifest, bundle] = await Promise.all([
    checkNoTrackingLive(html),
    checkBrandFontsLive(html),
    checkManifestLive(html, input.liveUrl),
    checkBundleSizeLive(html, input.liveUrl),
  ]);
  report.results.push(tracking, fonts, manifest, bundle);
  return report;
}

export function checkNoTrackingLive(html: string): CheckResult {
  const found = TRACKER_PATTERNS.filter((re) => re.test(html));
  if (found.length === 0) {
    return { name: 'No tracking SDKs (live)', status: 'pass', detail: 'no known trackers in HTML' };
  }
  return {
    name: 'No tracking SDKs (live)',
    status: 'fail',
    detail: `${found.length} pattern${found.length === 1 ? '' : 's'} matched`,
    suggestions: [
      'Tracking was injected after publish — remove the script tag or third-party loader.',
    ],
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
  const m = /<link[^>]*rel=["']manifest["'][^>]*href=["']([^"']+)["']/i.exec(html);
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
  // Find the largest-looking bundled JS reference. Vite output looks like
  // src="/assets/index-XYZ.js" — starts with `/`, no chars before. Use
  // `[^"']*` (zero or more) instead of `[^"']+` (one or more) so the
  // root-relative path matches; with `+` every Vite app was misreported
  // as "non-Vite layout" and the audit silently skipped bundle-size.
  const m = /<script[^>]+src=["']([^"']*\/assets\/[^"']+\.js)["']/i.exec(html);
  if (!m) {
    // Plausible miss for non-Vite apps — not a fail, just skip.
    return {
      name: 'Bundle size (live)',
      status: 'warn',
      detail: 'no /assets/*.js found — non-Vite layout?',
    };
  }
  const jsUrl = new URL(m[1]!, liveUrl).toString();
  try {
    const res = await fetchWithTimeout(jsUrl);
    if (!res.ok) {
      return { name: 'Bundle size (live)', status: 'fail', detail: `${jsUrl} → ${res.status}` };
    }
    const body = await res.arrayBuffer();
    // Approximate gzipped size as raw / 3.5. CompressionStream is in
    // Workers but adding a real gzip pass is more code; the
    // approximation is conservative enough for the 300 KB threshold.
    const rawKb = Math.round(body.byteLength / 1024);
    const approxGzipKb = Math.round(rawKb / 3.5);
    if (approxGzipKb > 300) {
      return {
        name: 'Bundle size (live)',
        status: 'fail',
        detail: `~${approxGzipKb} KB gzipped (raw ${rawKb} KB) — over 300 KB limit`,
      };
    }
    return {
      name: 'Bundle size (live)',
      status: 'pass',
      detail: `~${approxGzipKb} KB gzipped (raw ${rawKb} KB)`,
    };
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
}
