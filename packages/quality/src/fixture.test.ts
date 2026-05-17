// @vitest-environment jsdom
/**
 * Fixture-driven tests for snapshot() and the auditor's per-viewport
 * verdict.
 *
 * The spec lives at /tmp/freegamestore/audit-fixture/index.html
 * (deployed at https://auditor-fixture.freegamestore.online). Each
 * `?scenario=<id>` there is a deliberately-broken layout that the
 * platform auditor must catch. The fixture HTML *is* the spec; this
 * file is the unit-level mirror.
 *
 * Two-tier coverage:
 *   - this file (jsdom): replicates each scenario's effective DOM
 *     shape and asserts snapshot() reports the right thing.
 *   - fixture.live.test.ts (TODO; cron in CI): drives the deployed
 *     page in a real browser, captures the postMessage stream, and
 *     asserts the same expectations against the live build.
 *
 * Adding a new fixture scenario? Add its id to CANONICAL_SCENARIOS,
 * then either register a `scenario(id, ...)` block or add an entry
 * to NOT_UNIT_TESTABLE with the reason. The "fixture coverage guard"
 * test at the bottom fails loudly otherwise.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { snapshot } from './index.js';

/**
 * Every scenario id the fixture page defines. Order matches the
 * SCENARIOS object in the fixture HTML for easy diffing.
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

/**
 * Scenarios that intentionally have no jsdom-level mirror, with the
 * reason. The coverage guard treats these as covered.
 */
const NOT_UNIT_TESTABLE: Partial<Record<ScenarioId, string>> = {
  'vh-bug':
    'iOS Safari URL-bar dynamic viewport — requires a real device viewport. Covered by fixture.live.test.ts.',
  'no-reporter':
    'Tests *absence* of postMessage, not snapshot() output. Belongs in the live integration test.',
};

/** Populated by scenario() at registration time; checked by the coverage guard. */
const REGISTERED_SCENARIOS = new Set<ScenarioId>();

/**
 * Wrap describe() so every fixture-mirroring block registers its id
 * against CANONICAL_SCENARIOS. The string typing means a typo'd id
 * fails to compile rather than silently skipping coverage.
 */
function scenario(id: ScenarioId, fn: () => void): void {
  if (REGISTERED_SCENARIOS.has(id)) {
    throw new Error(`Duplicate scenario registration: ${id}`);
  }
  REGISTERED_SCENARIOS.add(id);
  describe(`fixture: ${id}`, fn);
}

beforeEach(() => {
  document.body.innerHTML = '';
  // Reset hostname so appId extraction is deterministic.
  Object.defineProperty(window, 'location', {
    value: { hostname: 'auditor-fixture.freegamestore.online' },
    configurable: true,
  });
});

/**
 * Set documentElement scroll dimensions. jsdom doesn't actually do
 * layout, so we have to mock these explicitly per test.
 */
function setDocSize(scrollW: number, scrollH: number, clientW: number, clientH: number) {
  const root = document.documentElement;
  Object.defineProperty(root, 'scrollWidth', { get: () => scrollW, configurable: true });
  Object.defineProperty(root, 'scrollHeight', { get: () => scrollH, configurable: true });
  Object.defineProperty(root, 'clientWidth', { get: () => clientW, configurable: true });
  Object.defineProperty(root, 'clientHeight', { get: () => clientH, configurable: true });
}

/**
 * Stub getComputedStyle to return a specific overflow per element.
 * Falls back to the original for elements not in the map.
 */
function withComputedStyles(map: Map<Element, Partial<CSSStyleDeclaration>>) {
  const orig = window.getComputedStyle;
  window.getComputedStyle = ((el: Element) => {
    const override = map.get(el);
    if (override) return { ...orig(el as Element), ...override } as CSSStyleDeclaration;
    return orig(el as Element);
  }) as typeof window.getComputedStyle;
}

/**
 * Stub element layout dimensions. jsdom returns 0 for everything, so
 * tests must set what they expect.
 */
function setElSize(
  el: Element,
  scrollW: number,
  scrollH: number,
  clientW: number,
  clientH: number,
) {
  Object.defineProperty(el, 'scrollWidth', { get: () => scrollW, configurable: true });
  Object.defineProperty(el, 'scrollHeight', { get: () => scrollH, configurable: true });
  Object.defineProperty(el, 'clientWidth', { get: () => clientW, configurable: true });
  Object.defineProperty(el, 'clientHeight', { get: () => clientH, configurable: true });
}

scenario('fits', () => {
  it('reports no scroll, no clipping, valid app id', () => {
    setDocSize(393, 852, 393, 852);
    document.body.innerHTML = '<div>Trivial layout</div>';
    const s = snapshot();
    expect(s.appId).toBe('auditor-fixture');
    expect(s.document.scrollsX).toBe(false);
    expect(s.document.scrollsY).toBe(false);
    expect(s.clipping).toEqual([]);
  });
});

scenario('scroll-x', () => {
  it('reports scrollsX=true (9999px-wide content)', () => {
    setDocSize(9999, 852, 393, 852);
    document.body.innerHTML = '<div style="width:9999px;height:100px"></div>';
    const s = snapshot();
    expect(s.document.scrollsX).toBe(true);
    expect(s.document.scrollsY).toBe(false);
    expect(s.document.scrollWidth).toBe(9999);
    expect(s.document.clientWidth).toBe(393);
  });
});

scenario('scroll-y', () => {
  it('reports scrollsY=true (9999px-tall content)', () => {
    setDocSize(393, 9999, 393, 852);
    const s = snapshot();
    expect(s.document.scrollsX).toBe(false);
    expect(s.document.scrollsY).toBe(true);
    expect(s.document.scrollHeight).toBe(9999);
  });
});

scenario('clip-inner', () => {
  it('document fits but inner element clips horizontally', () => {
    setDocSize(393, 852, 393, 852);
    document.body.innerHTML = '<div class="clipper"><div class="child"></div></div>';
    const clipper = document.querySelector('.clipper') as HTMLElement;
    const child = document.querySelector('.child') as HTMLElement;
    setElSize(clipper, 9999, 100, 100, 100);
    setElSize(child, 9999, 100, 9999, 100);
    withComputedStyles(
      new Map([
        [clipper, { overflowX: 'hidden', overflowY: 'visible' } as Partial<CSSStyleDeclaration>],
      ]),
    );
    const s = snapshot();
    // Document doesn't scroll — the clipper masks the overflow.
    expect(s.document.scrollsX).toBe(false);
    expect(s.document.scrollsY).toBe(false);
    // But the clipper IS clipping content.
    const hit = s.clipping.find((c) => c.selector.includes('clipper'));
    expect(hit).toBeDefined();
    expect(hit?.clipsX).toBe(true);
    expect(hit?.clipsY).toBe(false);
    expect(hit?.scrollWidth).toBe(9999);
    expect(hit?.clientWidth).toBe(100);
  });
});

scenario('clip-inner-y', () => {
  it('reports vertical clipping on a 50px-tall overflow:hidden parent', () => {
    setDocSize(393, 852, 393, 852);
    document.body.innerHTML = '<div class="clipper"></div>';
    const clipper = document.querySelector('.clipper') as HTMLElement;
    setElSize(clipper, 393, 999, 393, 50);
    withComputedStyles(
      new Map([
        [clipper, { overflowX: 'visible', overflowY: 'hidden' } as Partial<CSSStyleDeclaration>],
      ]),
    );
    const s = snapshot();
    const hit = s.clipping[0];
    expect(hit?.clipsY).toBe(true);
    expect(hit?.clipsX).toBe(false);
  });
});

scenario('gap-mid', () => {
  /**
   * Fixture CSS: a `.force` child with `min-width: 700px`, released
   * to `min-width: 0` only by `@media (min-width: 769px)` and
   * `@media (max-width: 599px)`. So at viewports 600–768 the child
   * stays 700px wide and pushes the document into horizontal scroll.
   *
   * jsdom does not evaluate @media. We simulate the *effective*
   * post-CSS document dimensions at three representative widths.
   * The complementary scoring assertion (bucket-summed share for a
   * mid-gap pass pattern) lives in index.test.ts under
   * `computeQualityIndex > catches a gap in the middle`.
   *
   * Fixture nuance, recorded but not "fixed" here (different repo):
   * the fixture's stated "fails at 600/768" is half-right. With the
   * fixture's `box-sizing: border-box` reset, a 700px-min-width child
   * fits inside a 768-32=736px content area. Only 600 actually
   * overflows. We assert the mathematically-true behaviour.
   */
  it('narrow viewport (393): @media max-width 599 releases min-width — fits', () => {
    setDocSize(393, 852, 393, 852);
    expect(snapshot().document.scrollsX).toBe(false);
  });

  it('mid viewport (600): no @media releases — 700px child overflows the 600px viewport', () => {
    setDocSize(700, 852, 600, 852);
    expect(snapshot().document.scrollsX).toBe(true);
  });

  it('wide viewport (1024): @media min-width 769 releases min-width — fits', () => {
    setDocSize(1024, 1366, 1024, 1366);
    expect(snapshot().document.scrollsX).toBe(false);
  });
});

scenario('landscape-only-bad', () => {
  /**
   * Fixture CSS: `.ok` has no width constraint by default; under
   * `@media (orientation: landscape)` it gets `width: 1500px`. So
   * portrait viewports fit cleanly and landscape viewports overflow
   * horizontally on every device narrower than 1500px.
   *
   * The complementary scoring assertion (overall = min(portrait,
   * landscape) for any-orientation apps) lives in index.test.ts
   * under `computeQualityIndex > overall = min of orientation
   * scores`.
   */
  it('portrait viewport (393×852): no width override — fits', () => {
    setDocSize(393, 852, 393, 852);
    expect(snapshot().document.scrollsX).toBe(false);
  });

  it('landscape viewport (852×393): @media orientation:landscape forces 1500px — overflows', () => {
    setDocSize(1500, 393, 852, 393);
    const s = snapshot();
    expect(s.document.scrollsX).toBe(true);
    expect(s.document.scrollWidth).toBe(1500);
    expect(s.document.clientWidth).toBe(852);
  });
});

scenario('large-scrollwidth-fp', () => {
  it('does NOT flag clipping when scrollWidth exceeds clientWidth by ≤1px (rounding)', () => {
    setDocSize(393, 852, 393, 852);
    document.body.innerHTML = '<div class="grid"></div>';
    const grid = document.querySelector('.grid') as HTMLElement;
    // Sub-pixel rounding: scrollWidth = 394 in a 393-wide container.
    setElSize(grid, 394, 100, 393, 100);
    withComputedStyles(
      new Map([
        [grid, { overflowX: 'hidden', overflowY: 'visible' } as Partial<CSSStyleDeclaration>],
      ]),
    );
    const s = snapshot();
    expect(s.clipping).toEqual([]);
  });

  it('DOES flag clipping when overflow exceeds 1px', () => {
    setDocSize(393, 852, 393, 852);
    document.body.innerHTML = '<div class="grid"></div>';
    const grid = document.querySelector('.grid') as HTMLElement;
    setElSize(grid, 395, 100, 393, 100); // 2px overflow
    withComputedStyles(
      new Map([
        [grid, { overflowX: 'hidden', overflowY: 'visible' } as Partial<CSSStyleDeclaration>],
      ]),
    );
    const s = snapshot();
    expect(s.clipping.length).toBe(1);
  });
});

/**
 * Extras — cover snapshot() behaviour that isn't a fixture scenario
 * but is referenced by the same auditor contract. Kept here to live
 * next to the scenarios they shore up; not registered against
 * CANONICAL_SCENARIOS.
 */
describe('extra: overflow:clip parity with overflow:hidden', () => {
  it('treats overflow:clip the same as overflow:hidden', () => {
    setDocSize(393, 852, 393, 852);
    document.body.innerHTML = '<div class="clipper"></div>';
    const clipper = document.querySelector('.clipper') as HTMLElement;
    setElSize(clipper, 500, 100, 100, 100);
    withComputedStyles(
      new Map([
        [clipper, { overflowX: 'clip', overflowY: 'visible' } as Partial<CSSStyleDeclaration>],
      ]),
    );
    const s = snapshot();
    expect(s.clipping.length).toBe(1);
    expect(s.clipping[0]?.clipsX).toBe(true);
  });
});

describe('extra: scroll containers (overflow:auto/scroll) are NOT clipping', () => {
  it('overflow:auto with overflowing content does not register as clipping', () => {
    // Justification: overflow:auto means the user CAN scroll inside.
    // It's a UX warning, not a hidden-content bug. The reporter's
    // clipping field is reserved for the hidden case.
    setDocSize(393, 852, 393, 852);
    document.body.innerHTML = '<div class="scroller"></div>';
    const sc = document.querySelector('.scroller') as HTMLElement;
    setElSize(sc, 9999, 100, 393, 100);
    withComputedStyles(
      new Map([[sc, { overflowX: 'auto', overflowY: 'visible' } as Partial<CSSStyleDeclaration>]]),
    );
    const s = snapshot();
    expect(s.clipping).toEqual([]);
  });
});

/**
 * Coverage guard. Every id in CANONICAL_SCENARIOS must be either
 * registered via scenario() above OR explicitly listed in
 * NOT_UNIT_TESTABLE with a reason. Adding a fixture scenario without
 * touching this file fails CI here, with a message naming the gap.
 */
describe('fixture coverage guard', () => {
  it('every canonical scenario is either unit-tested or marked not-unit-testable', () => {
    const skipped = new Set(Object.keys(NOT_UNIT_TESTABLE) as ScenarioId[]);
    const covered = new Set<ScenarioId>([...REGISTERED_SCENARIOS, ...skipped]);
    const missing = CANONICAL_SCENARIOS.filter((id) => !covered.has(id));
    expect(
      missing,
      `Fixture scenarios with no unit mirror and no NOT_UNIT_TESTABLE entry: ${missing.join(', ')}`,
    ).toEqual([]);
  });

  it('no scenario is double-counted (registered AND marked not-unit-testable)', () => {
    const skipped = new Set(Object.keys(NOT_UNIT_TESTABLE) as ScenarioId[]);
    const overlap = [...REGISTERED_SCENARIOS].filter((id) => skipped.has(id));
    expect(overlap, `Scenarios both tested and skipped: ${overlap.join(', ')}`).toEqual([]);
  });

  it('NOT_UNIT_TESTABLE keys are all canonical', () => {
    // Defends against typos in NOT_UNIT_TESTABLE keys silently passing
    // the guard. (CANONICAL_SCENARIOS is `as const` typed, so the
    // ScenarioId Partial<Record<...>> already enforces this at compile
    // time — this is a runtime belt for future refactors that widen
    // the key type.)
    const canon = new Set<string>(CANONICAL_SCENARIOS);
    const stray = Object.keys(NOT_UNIT_TESTABLE).filter((id) => !canon.has(id));
    expect(stray, `NOT_UNIT_TESTABLE has non-canonical keys: ${stray.join(', ')}`).toEqual([]);
  });
});
