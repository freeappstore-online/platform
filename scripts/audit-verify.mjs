#!/usr/bin/env node
import { writeFileSync } from 'node:fs';
/**
 * Ground-truth verifier for the production audit.
 *
 * The audit Worker runs static-string checks against fetched HTML
 * (no JS execution, no layout). This script independently verifies
 * each verdict by actually loading every app in headless Chromium
 * and checking what really happens — tracking SDKs that load via
 * dynamic imports, fonts that load via @import in CSS, content that
 * scrolls or clips, etc.
 *
 * Run after every audit to confirm the audit's verdicts match reality.
 * Discrepancies are bugs in the audit, not the apps.
 *
 * Usage:
 *   node scripts/audit-verify.mjs           # all apps, both stores
 *   node scripts/audit-verify.mjs --only tetris,hangman
 *   node scripts/audit-verify.mjs --json    # machine-readable output
 */
import { chromium } from 'playwright';

const AUDIT_API = 'https://api.freeappstore.online/v1/audit';

const args = new Set(process.argv.slice(2));
const onlyArg = process.argv.find((a) => a.startsWith('--only='));
const only = onlyArg ? onlyArg.slice('--only='.length).split(',') : null;
const asJson = args.has('--json');

const TRACKER_PATTERNS = [
  /google-analytics\.com/i,
  /googletagmanager\.com/i,
  /\bgtag\(/i,
  /\bamplitude\b/i,
  /\bmixpanel\b/i,
  /\bsegment\.com\b/i,
  /\bhotjar\.com\b/i,
  /plausible\.io/i,
  /posthog\.com/i,
];

async function fetchAuditSummary() {
  const res = await fetch(AUDIT_API);
  const data = await res.json();
  // Group checks by app
  const byApp = new Map();
  for (const check of data.checks ?? []) {
    if (!byApp.has(check.appId)) byApp.set(check.appId, { store: check.store, checks: [] });
    byApp.get(check.appId).checks.push(check);
  }
  return byApp;
}

async function fetchRegistry(store) {
  const owner = store === 'apps' ? 'freeappstore-online' : 'freegamestore-online';
  const repo = store === 'apps' ? 'freeappstore' : 'freegamestore';
  const res = await fetch(`https://raw.githubusercontent.com/${owner}/${repo}/main/registry.json`);
  const body = await res.json();
  return store === 'apps' ? (body.apps ?? []) : (body.games ?? []);
}

async function groundTruth(page, app) {
  const result = {
    appId: app.id,
    store: app.store,
    url: app.appUrl,
    truth: {},
    error: null,
  };
  try {
    const networkRequests = [];
    page.on('request', (r) => networkRequests.push(r.url()));
    const resp = await page.goto(app.appUrl, { waitUntil: 'networkidle', timeout: 20000 });
    result.truth.reachable = resp != null && resp.status() < 400;
    result.truth.httpStatus = resp?.status() ?? 0;
    if (!result.truth.reachable) return result;

    await page.waitForTimeout(800);

    // Tracking: scan ALL network requests + HTML, not just the static HTML
    const allUrls = networkRequests.join(' ');
    const html = await page.content();
    const trackerMatches = TRACKER_PATTERNS.filter((re) => re.test(html) || re.test(allUrls));
    result.truth.trackers = trackerMatches.map((re) => re.source);

    // Brand fonts: check via getComputedStyle on h1/body
    const fontInfo = await page.evaluate(() => {
      const sample = document.querySelector('h1, h2, h3') || document.body;
      const cs = getComputedStyle(sample);
      const bodyCs = getComputedStyle(document.body);
      const linkHrefs = Array.from(document.querySelectorAll('link[rel="stylesheet"]'))
        .map((l) => l.href)
        .join(' ');
      return {
        sampleFont: cs.fontFamily,
        bodyFont: bodyCs.fontFamily,
        hasManropeRef:
          /manrope/i.test(linkHrefs) || /manrope/i.test(document.documentElement.outerHTML),
        hasFrauncesRef:
          /fraunces/i.test(linkHrefs) || /fraunces/i.test(document.documentElement.outerHTML),
      };
    });
    result.truth.fontInfo = fontInfo;

    // Manifest: fetch + parse
    const manifestUrl = await page.evaluate(() => {
      const link = document.querySelector('link[rel="manifest"]');
      return link ? new URL(link.href, location.href).toString() : null;
    });
    if (manifestUrl) {
      try {
        const mres = await fetch(manifestUrl);
        if (mres.ok) {
          const mbody = await mres.json();
          result.truth.manifest = {
            url: manifestUrl,
            hasName: !!mbody.name,
            hasDisplay: !!mbody.display,
            hasStartUrl: !!mbody.start_url,
            orientation: mbody.orientation || null,
            minViewportWidth: mbody.min_viewport_width || null,
          };
        } else {
          result.truth.manifest = { url: manifestUrl, fetchStatus: mres.status };
        }
      } catch (e) {
        result.truth.manifest = { url: manifestUrl, error: e.message };
      }
    } else {
      result.truth.manifest = null;
    }

    // Viewport fit at iPhone 15 (393x852) — the most common phone size
    await page.setViewportSize({ width: 393, height: 852 });
    await page.waitForTimeout(500);
    const fitInfo = await page.evaluate(() => {
      const root = document.documentElement;
      const clipping = [];
      const all = document.querySelectorAll('*');
      for (const el of all) {
        const cs = getComputedStyle(el);
        const ovx = cs.overflowX,
          ovy = cs.overflowY;
        const xClip = (ovx === 'hidden' || ovx === 'clip') && el.scrollWidth > el.clientWidth + 1;
        const yClip = (ovy === 'hidden' || ovy === 'clip') && el.scrollHeight > el.clientHeight + 1;
        if (xClip || yClip) {
          clipping.push({
            tag: el.tagName.toLowerCase(),
            cls: (el.className || '').toString().slice(0, 40),
            scrollW: el.scrollWidth,
            scrollH: el.scrollHeight,
            clientW: el.clientWidth,
            clientH: el.clientHeight,
            clipsX: xClip,
            clipsY: yClip,
          });
        }
      }
      return {
        docW: root.scrollWidth,
        docH: root.scrollHeight,
        viewW: root.clientWidth,
        viewH: root.clientHeight,
        scrollsX: root.scrollWidth > root.clientWidth + 1,
        scrollsY: root.scrollHeight > root.clientHeight + 1,
        clippingCount: clipping.length,
        worstClips: clipping.slice(0, 3),
      };
    });
    result.truth.viewportFit = fitInfo;
  } catch (e) {
    result.error = e.message;
  }
  return result;
}

function compareToAudit(truth, auditChecks) {
  // For each audit check, determine if its verdict matches truth.
  const diffs = [];
  const auditByName = new Map(auditChecks.map((c) => [c.checkName, c]));

  // Reachable
  const auditReach = auditByName.get('Reachable');
  if (auditReach && auditReach.status === 'fail' && truth.reachable) {
    diffs.push({
      check: 'Reachable',
      auditSays: 'fail',
      truth: 'reachable=true',
      reason: auditReach.detail,
    });
  }

  // No tracking SDKs
  const auditTrack = auditByName.get('No tracking SDKs (live)');
  const truthHasTracker = (truth.trackers || []).length > 0;
  if (auditTrack && auditTrack.status === 'pass' && truthHasTracker) {
    diffs.push({
      check: 'No tracking SDKs',
      auditSays: 'pass',
      truth: `trackers loaded at runtime: ${truth.trackers.join(', ')}`,
    });
  }
  if (auditTrack && auditTrack.status === 'fail' && !truthHasTracker) {
    diffs.push({
      check: 'No tracking SDKs',
      auditSays: 'fail',
      truth: 'no trackers actually load',
    });
  }

  // Brand fonts
  const auditFonts = auditByName.get('Brand fonts (live)');
  if (auditFonts && truth.fontInfo) {
    const truthHasBoth = truth.fontInfo.hasManropeRef && truth.fontInfo.hasFrauncesRef;
    if (auditFonts.status === 'pass' && !truthHasBoth) {
      diffs.push({
        check: 'Brand fonts',
        auditSays: 'pass',
        truth: `Manrope=${truth.fontInfo.hasManropeRef} Fraunces=${truth.fontInfo.hasFrauncesRef}`,
      });
    }
  }

  // PWA manifest
  const auditMan = auditByName.get('PWA manifest (live)');
  if (auditMan && truth.manifest) {
    const truthValid =
      truth.manifest.hasName && truth.manifest.hasDisplay && truth.manifest.hasStartUrl;
    if (auditMan.status === 'pass' && !truthValid) {
      diffs.push({
        check: 'PWA manifest',
        auditSays: 'pass',
        truth: `manifest missing fields (name=${truth.manifest.hasName} display=${truth.manifest.hasDisplay} start_url=${truth.manifest.hasStartUrl})`,
      });
    }
    // Audit failed but it's actually a subrequest-cap noise → flag separately
    if (auditMan.status === 'fail' && truthValid && /subrequest/i.test(auditMan.detail || '')) {
      diffs.push({
        check: 'PWA manifest',
        auditSays: 'fail (subrequest cap noise)',
        truth: 'manifest is fine',
        flag: 'audit-noise',
      });
    }
  }

  // Viewport fit — gap: not part of audit yet
  if (
    truth.viewportFit &&
    (truth.viewportFit.scrollsX ||
      truth.viewportFit.scrollsY ||
      truth.viewportFit.clippingCount > 0)
  ) {
    diffs.push({
      check: 'Viewport fit (NOT IN AUDIT)',
      auditSays: 'n/a',
      truth: `iPhone 15: scrollsX=${truth.viewportFit.scrollsX} scrollsY=${truth.viewportFit.scrollsY} clipping=${truth.viewportFit.clippingCount}`,
      flag: 'audit-gap',
    });
  }

  return diffs;
}

async function main() {
  const audit = await fetchAuditSummary();
  const apps = [
    ...(await fetchRegistry('apps')).map((a) => ({ ...a, store: 'apps' })),
    ...(await fetchRegistry('games')).map((a) => ({ ...a, store: 'games' })),
  ].filter((a) => !only || only.includes(a.id));
  if (!asJson) console.log(`\nVerifying ${apps.length} apps against audit verdicts.\n`);

  const browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport: { width: 1024, height: 768 } });
  const page = await ctx.newPage();

  const all = [];
  for (const app of apps) {
    const truth = await groundTruth(page, app);
    const auditEntry = audit.get(app.id);
    const diffs = auditEntry ? compareToAudit(truth.truth, auditEntry.checks) : [];
    all.push({ appId: app.id, store: app.store, diffs, truth: truth.truth, error: truth.error });

    if (!asJson) {
      const status = diffs.length === 0 ? '✓' : '✗';
      const noise = diffs.filter((d) => d.flag === 'audit-noise').length;
      const gaps = diffs.filter((d) => d.flag === 'audit-gap').length;
      const real = diffs.length - noise - gaps;
      const summary =
        diffs.length === 0
          ? 'audit matches truth'
          : `${real} real diff${real === 1 ? '' : 's'}, ${noise} noise, ${gaps} gap${gaps === 1 ? '' : 's'}`;
      console.log(`${status} ${app.id.padEnd(18)} ${summary}`);
      for (const d of diffs) {
        const tag = d.flag ? `[${d.flag}]` : '[REAL]';
        console.log(`   ${tag} ${d.check}: audit=${d.auditSays} → truth=${d.truth}`);
      }
    }
  }

  await browser.close();

  if (asJson) {
    console.log(JSON.stringify({ verifiedAt: Date.now(), results: all }, null, 2));
  } else {
    const totalReal = all.reduce(
      (n, r) => n + r.diffs.filter((d) => !d.flag || d.flag === 'audit-error').length,
      0,
    );
    const totalNoise = all.reduce(
      (n, r) => n + r.diffs.filter((d) => d.flag === 'audit-noise').length,
      0,
    );
    const totalGaps = all.reduce(
      (n, r) => n + r.diffs.filter((d) => d.flag === 'audit-gap').length,
      0,
    );
    console.log(`\nDone. ${totalReal} real, ${totalNoise} noise, ${totalGaps} gap.\n`);
    writeFileSync(
      '/tmp/audit-verify-report.json',
      JSON.stringify({ verifiedAt: Date.now(), results: all }, null, 2),
    );
    console.log('Detailed JSON: /tmp/audit-verify-report.json\n');
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
