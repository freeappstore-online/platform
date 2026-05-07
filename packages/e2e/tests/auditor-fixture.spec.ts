import { test, expect, Page } from '@playwright/test';
import type { ViewportReport } from '../../quality/src/index.js';

// Provided by Node at runtime; declared inline because @playwright/test
// doesn't pull in @types/node and we don't want to add it just for one ref.
declare const process: { env: Record<string, string | undefined> };

/**
 * Live mirror of the auditor fixture (auditor-fixture.freegamestore.online).
 *
 * Companion to packages/quality/src/fixture.test.ts. The unit suite
 * proves snapshot() handles the right *shapes* in jsdom; this suite
 * proves the deployed fixture, the published @freeappstore/quality on
 * esm.sh, and a real Chromium engine all agree on the verdict.
 *
 * Adding a new fixture scenario? Add its id to CANONICAL_SCENARIOS,
 * then either register a `scenario(id, ...)` block or add an entry
 * to NOT_LIVE_TESTABLE with the reason. The coverage guard test at
 * the bottom — and an additional cross-check that scrapes the live
 * fixture index — fail loudly otherwise.
 */

/**
 * Production URL. The fixture deploys path-based under the storefront
 * (build.js in the freegamestore repo copies audit-fixture/ into
 * dist/audit-fixture/). A subdomain deploy would also work — and
 * snapshot()'s appId regex is biased toward subdomains — but path is
 * simpler since CF Pages auto-deploys the storefront on every push.
 *
 * Override via FAS_FIXTURE_BASE for local dev (e.g. point at a
 * Python http.server hosting audit-fixture/) or a staging URL.
 */
const FIXTURE_BASE = (process.env.FAS_FIXTURE_BASE ?? 'https://freegamestore.online/audit-fixture')
  .replace(/\/+$/, '');
/** Pinned to the version the fixture HTML imports. Bump together. */
const REPORTER_ESM = 'https://esm.sh/@freeappstore/quality@0.1.0';

/**
 * If the fixture host has the production *.freegamestore.online shape,
 * snapshot()'s appId regex extracts the leftmost label. For other
 * hosts (local dev, staging on a different domain) the regex returns
 * '' and we don't assert any specific id. Mirrors the source-of-truth
 * regex in packages/quality/src/index.ts.
 */
const EXPECTED_APP_ID = (() => {
  const host = new URL(FIXTURE_BASE).hostname;
  const m = /^([^.]+)\.(?:freeappstore|freegamestore)\.online$/.exec(host);
  return m?.[1] ?? '';
})();

/**
 * Mirror of CANONICAL_SCENARIOS in packages/quality/src/fixture.test.ts.
 * The fixture-index sanity test below cross-checks this against the
 * deployed page, so genuine drift between this list and the spec
 * surfaces in CI.
 */
const CANONICAL_SCENARIOS = [
  'fits',
  'scroll-x',
  'scroll-y',
  'clip-inner',
  'clip-inner-y',
  'vh-bug',
  'gap-mid',
  'landscape-only-bad',
  'no-reporter',
  'large-scrollwidth-fp',
] as const;
type ScenarioId = (typeof CANONICAL_SCENARIOS)[number];

const NOT_LIVE_TESTABLE: Partial<Record<ScenarioId, string>> = {
  'vh-bug':
    'Requires real iOS Safari URL-bar dynamics — desktop Chromium and a fixed Playwright viewport cannot reproduce the visualViewport vs layoutViewport split.',
  'no-reporter':
    'Asserts the *absence* of postMessage. Covered explicitly by the dedicated test below, not via the registered-scenario path.',
};

/** Populated by scenario() at registration time; checked by the coverage guard. */
const REGISTERED_SCENARIOS = new Set<ScenarioId>();

function scenario(id: ScenarioId, fn: () => void): void {
  if (REGISTERED_SCENARIOS.has(id)) {
    throw new Error(`Duplicate scenario registration: ${id}`);
  }
  REGISTERED_SCENARIOS.add(id);
  test.describe(`fixture: ${id}`, fn);
}

/**
 * Navigate to a fixture scenario at a specific viewport, then ask the
 * page for a snapshot via the published reporter. The fixture itself
 * already imports + initialises the reporter, so re-importing is a
 * cache hit; we call snapshot() directly because the reporter only
 * posts to a parent (which we don't have here — the page is loaded
 * top-level by Playwright).
 */
async function snapshotAt(
  page: Page,
  id: ScenarioId,
  viewport: { width: number; height: number },
): Promise<ViewportReport> {
  await page.setViewportSize(viewport);
  // networkidle waits for the fixture's `await import(esm.sh/...)` to
  // settle; without it snapshot() can race the reporter's own load.
  await page.goto(`${FIXTURE_BASE}/?scenario=${id}`, { waitUntil: 'networkidle' });
  // Layout depends on font metrics; document.fonts.ready is the
  // browser's own "fonts settled" signal — deterministic and faster
  // than a fixed timeout.
  await page.evaluate(() => document.fonts?.ready ?? Promise.resolve());
  return await page.evaluate(async (esmUrl) => {
    const m = await import(/* @vite-ignore */ esmUrl);
    return m.snapshot() as ViewportReport;
  }, REPORTER_ESM);
}

/**
 * One-shot reachability probe. With this, an unreachable fixture
 * fails ONCE with a clear message instead of producing N×projects
 * timeouts that bury the actual cause.
 */
test.beforeAll(async () => {
  let res: Response;
  try {
    res = await fetch(`${FIXTURE_BASE}/`, { method: 'GET' });
  } catch (err) {
    throw new Error(
      `Auditor fixture unreachable at ${FIXTURE_BASE}\n` +
        `Cause: ${(err as Error).message}\n` +
        `Override the host with FAS_FIXTURE_BASE=https://your-host (e.g. a wrangler pages dev URL).`,
    );
  }
  if (!res.ok) {
    throw new Error(
      `Auditor fixture at ${FIXTURE_BASE}/ returned HTTP ${res.status}\n` +
        `Override the host with FAS_FIXTURE_BASE=https://your-host (e.g. a wrangler pages dev URL).`,
    );
  }
});

scenario('fits', () => {
  test('iPhone 15 portrait: no scroll, no clipping', async ({ page }) => {
    const s = await snapshotAt(page, 'fits', { width: 393, height: 852 });
    expect(s.document.scrollsX).toBe(false);
    expect(s.document.scrollsY).toBe(false);
    expect(s.clipping).toEqual([]);
    expect(s.appId).toBe(EXPECTED_APP_ID);
  });
});

scenario('scroll-x', () => {
  test('iPhone 15 portrait: scrollsX=true (9999px content)', async ({ page }) => {
    const s = await snapshotAt(page, 'scroll-x', { width: 393, height: 852 });
    expect(s.document.scrollsX).toBe(true);
  });
});

scenario('scroll-y', () => {
  test('iPhone 15 portrait: scrollsY=true (9999px content)', async ({ page }) => {
    const s = await snapshotAt(page, 'scroll-y', { width: 393, height: 852 });
    expect(s.document.scrollsY).toBe(true);
  });
});

scenario('clip-inner', () => {
  test('document fits but a .clipper element clips horizontally', async ({ page }) => {
    const s = await snapshotAt(page, 'clip-inner', { width: 393, height: 852 });
    expect(s.document.scrollsX).toBe(false);
    const hit = s.clipping.find((c) => c.selector.includes('clipper'));
    expect(hit, 'expected at least one .clipper hit in s.clipping').toBeDefined();
    expect(hit?.clipsX).toBe(true);
    expect(hit?.clipsY).toBe(false);
  });
});

scenario('clip-inner-y', () => {
  test('a 50px-tall .clipper element clips its tall child vertically', async ({ page }) => {
    const s = await snapshotAt(page, 'clip-inner-y', { width: 393, height: 852 });
    expect(s.document.scrollsY).toBe(false);
    const hit = s.clipping.find((c) => c.selector.includes('clipper'));
    expect(hit).toBeDefined();
    expect(hit?.clipsY).toBe(true);
  });
});

scenario('gap-mid', () => {
  /**
   * Width-dependent CSS @media rules release the 700px min-width below
   * 600 and at/above 769. Validates the reporter sees the page as the
   * browser actually lays it out at three representative widths. The
   * complementary scoring test (bucket-summed share) lives in
   * packages/quality/src/index.test.ts.
   *
   * Same fixture-narrative caveat as the unit test: the fixture's
   * "fails at 600/768" is half-right under box-sizing: border-box;
   * 768-32=736 fits a 700px-min-width child. Only 600 actually scrolls.
   */
  test('narrow viewport (393×852): @media releases min-width — fits', async ({ page }) => {
    const s = await snapshotAt(page, 'gap-mid', { width: 393, height: 852 });
    expect(s.document.scrollsX).toBe(false);
  });

  test('mid viewport (600×800): 700px min-width child overflows', async ({ page }) => {
    const s = await snapshotAt(page, 'gap-mid', { width: 600, height: 800 });
    expect(s.document.scrollsX).toBe(true);
  });

  test('wide viewport (1024×1366): @media releases min-width — fits', async ({ page }) => {
    const s = await snapshotAt(page, 'gap-mid', { width: 1024, height: 1366 });
    expect(s.document.scrollsX).toBe(false);
  });
});

scenario('landscape-only-bad', () => {
  /**
   * Layout fits in portrait; under @media (orientation: landscape) the
   * .ok element grows to 1500px and overflows every device narrower
   * than that. The complementary "overall = min(portrait, landscape)"
   * scoring assertion lives in packages/quality/src/index.test.ts.
   *
   * Playwright treats viewport WIDTH > HEIGHT as landscape — same rule
   * the CSS @media uses — so simply setting a wide-and-short viewport
   * is enough to trigger the breakpoint.
   */
  test('portrait viewport (393×852): no width override — fits', async ({ page }) => {
    const s = await snapshotAt(page, 'landscape-only-bad', { width: 393, height: 852 });
    expect(s.document.scrollsX).toBe(false);
  });

  test('landscape viewport (852×393): @media forces 1500px — overflows', async ({ page }) => {
    const s = await snapshotAt(page, 'landscape-only-bad', { width: 852, height: 393 });
    expect(s.document.scrollsX).toBe(true);
  });
});

scenario('large-scrollwidth-fp', () => {
  test('20-col grid with sub-pixel rounding does NOT register as clipping', async ({ page }) => {
    const s = await snapshotAt(page, 'large-scrollwidth-fp', { width: 393, height: 852 });
    // The 1px tolerance in snapshot() should swallow the grid's
    // scrollWidth - clientWidth delta for fractional column sizes.
    const gridHits = s.clipping.filter((c) => c.selector.includes('grid'));
    expect(gridHits).toEqual([]);
  });
});

/**
 * Dedicated no-reporter test. Cannot use snapshotAt() here because the
 * fixture deliberately doesn't load the reporter for this scenario, so
 * the dynamic import inside page.evaluate would itself BE the reporter
 * load — defeating the test. We assert by listening for postMessages
 * during a fixed window and confirming the reporter never posts on its
 * own.
 */
test('no-reporter: page never posts a fas:quality message', async ({ page }) => {
  // Set window.parent.postMessage equivalent: the reporter only posts
  // when window.parent !== window. On a top-level Playwright page they
  // are equal, so even a normally-loaded reporter would no-op. We have
  // to detect the *absence of the import itself*. Easiest: watch
  // network for esm.sh/@freeappstore/quality and assert no such
  // request is made.
  const reporterRequests: string[] = [];
  page.on('request', (req) => {
    const url = req.url();
    if (url.includes('@freeappstore/quality') || url.includes('freeappstore-quality')) {
      reporterRequests.push(url);
    }
  });
  await page.goto(`${FIXTURE_BASE}/?scenario=no-reporter`, { waitUntil: 'networkidle' });
  await page.waitForTimeout(500);
  expect(
    reporterRequests,
    `no-reporter scenario must not import the reporter; saw: ${reporterRequests.join(', ')}`,
  ).toEqual([]);
});

/**
 * Cross-check the local CANONICAL_SCENARIOS list against the deployed
 * fixture index page. If the fixture HTML adds a scenario without an
 * update here, the scrape returns an unknown id and this test fails
 * loudly, naming the missing id. Runs before the in-process coverage
 * guard so the failure surface is "fixture changed, your tests are
 * stale" — a more actionable message than "your local test list is
 * inconsistent."
 */
test('fixture index lists exactly CANONICAL_SCENARIOS', async ({ page }) => {
  await page.goto(`${FIXTURE_BASE}/`, { waitUntil: 'networkidle' });
  const liveIds = await page.$$eval('a[href*="scenario="]', (anchors) =>
    anchors.map((a) => {
      const href = (a as HTMLAnchorElement).href;
      const m = /[?&]scenario=([^&]+)/.exec(href);
      return m ? decodeURIComponent(m[1]!) : '';
    }).filter(Boolean),
  );
  // Sort for stable diff messaging.
  expect(new Set(liveIds), 'fixture page exposes a different scenario set than this spec').toEqual(
    new Set(CANONICAL_SCENARIOS),
  );
});

test.describe('fixture coverage guard', () => {
  test('every canonical scenario is either live-tested or marked not-live-testable', () => {
    const skipped = new Set(Object.keys(NOT_LIVE_TESTABLE) as ScenarioId[]);
    const covered = new Set<ScenarioId>([...REGISTERED_SCENARIOS, ...skipped]);
    const missing = CANONICAL_SCENARIOS.filter((id) => !covered.has(id));
    expect(
      missing,
      `Fixture scenarios with no live mirror and no NOT_LIVE_TESTABLE entry: ${missing.join(', ')}`,
    ).toEqual([]);
  });

  test('no scenario is double-counted (registered AND marked not-live-testable)', () => {
    const skipped = new Set(Object.keys(NOT_LIVE_TESTABLE) as ScenarioId[]);
    const overlap = [...REGISTERED_SCENARIOS].filter((id) => skipped.has(id));
    expect(overlap, `Scenarios both tested and skipped: ${overlap.join(', ')}`).toEqual([]);
  });

  test('NOT_LIVE_TESTABLE keys are all canonical', () => {
    const canon = new Set<string>(CANONICAL_SCENARIOS);
    const stray = Object.keys(NOT_LIVE_TESTABLE).filter((id) => !canon.has(id));
    expect(stray, `NOT_LIVE_TESTABLE has non-canonical keys: ${stray.join(', ')}`).toEqual([]);
  });
});
