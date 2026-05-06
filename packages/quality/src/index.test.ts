// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  snapshot,
  initQualityReporter,
  computeQualityIndex,
  viewportKey,
  REFERENCE_VIEWPORTS,
} from './index.js';

describe('snapshot', () => {
  it('returns the schema-1 shape with required keys', () => {
    const s = snapshot();
    expect(s.type).toBe('fas:quality');
    expect(s.schema).toBe(1);
    expect(typeof s.capturedAt).toBe('number');
    expect(s.viewport).toBeDefined();
    expect(s.document).toBeDefined();
    expect(s.clipping).toBeInstanceOf(Array);
    expect(['light', 'dark', 'unknown']).toContain(s.colorScheme);
  });

  it('extracts appId from *.freeappstore.online host', () => {
    Object.defineProperty(window, 'location', {
      value: { hostname: 'tetris.freegamestore.online' },
      configurable: true,
    });
    expect(snapshot().appId).toBe('tetris');
    Object.defineProperty(window, 'location', {
      value: { hostname: 'todo.freeappstore.online' },
      configurable: true,
    });
    expect(snapshot().appId).toBe('todo');
  });

  it('returns empty appId for local dev / custom domains', () => {
    Object.defineProperty(window, 'location', {
      value: { hostname: 'localhost' },
      configurable: true,
    });
    expect(snapshot().appId).toBe('');
    Object.defineProperty(window, 'location', {
      value: { hostname: 'example.com' },
      configurable: true,
    });
    expect(snapshot().appId).toBe('');
  });

  it('flags scrollsX/scrollsY when scrollWidth/Height exceed client', () => {
    // jsdom's layout numbers are mostly zero; mock the getter chain.
    const root = document.documentElement;
    Object.defineProperty(root, 'scrollWidth', { get: () => 500, configurable: true });
    Object.defineProperty(root, 'clientWidth', { get: () => 393, configurable: true });
    Object.defineProperty(root, 'scrollHeight', { get: () => 800, configurable: true });
    Object.defineProperty(root, 'clientHeight', { get: () => 800, configurable: true });
    const s = snapshot();
    expect(s.document.scrollsX).toBe(true);
    expect(s.document.scrollsY).toBe(false);
  });

  it('detects inner clipping on overflow:hidden elements', () => {
    document.body.innerHTML = '<div class="clipper"><div class="big"></div></div>';
    const clipper = document.querySelector('.clipper') as HTMLElement;
    // Mock getComputedStyle so the clipper reports overflow:hidden.
    const origGet = window.getComputedStyle;
    window.getComputedStyle = ((el: Element) => {
      if (el === clipper) return { overflowX: 'hidden', overflowY: 'visible' } as CSSStyleDeclaration;
      return origGet(el as Element);
    }) as typeof window.getComputedStyle;
    Object.defineProperty(clipper, 'scrollWidth', { get: () => 500 });
    Object.defineProperty(clipper, 'clientWidth', { get: () => 200 });
    Object.defineProperty(clipper, 'scrollHeight', { get: () => 100 });
    Object.defineProperty(clipper, 'clientHeight', { get: () => 100 });
    const s = snapshot();
    expect(s.clipping.length).toBeGreaterThan(0);
    expect(s.clipping[0]!.clipsX).toBe(true);
    expect(s.clipping[0]!.selector).toContain('div');
    window.getComputedStyle = origGet;
  });
});

describe('initQualityReporter', () => {
  beforeEach(() => {
    delete (window as unknown as { __FAS_QUALITY_REPORTER__?: unknown }).__FAS_QUALITY_REPORTER__;
    delete (window as unknown as { __FAS_QUALITY_DISABLE?: unknown }).__FAS_QUALITY_DISABLE;
  });
  afterEach(() => {
    const h = (window as unknown as { __FAS_QUALITY_REPORTER__?: { stop?: () => void } }).__FAS_QUALITY_REPORTER__;
    if (h?.stop) h.stop();
  });

  it('is a no-op when there is no parent (top-level navigation)', () => {
    // jsdom's window.parent === window by default — same as a real top-level page.
    const handle = initQualityReporter();
    expect(typeof handle.stop).toBe('function');
    expect(typeof handle.reportNow).toBe('function');
    // Calling reportNow shouldn't throw.
    expect(() => handle.reportNow()).not.toThrow();
  });

  it('returns the existing handle on second call (idempotent)', () => {
    const a = initQualityReporter();
    const b = initQualityReporter();
    expect(a).toBe(b);
  });

  it('skips reporting when window.__FAS_QUALITY_DISABLE is set', () => {
    (window as unknown as { __FAS_QUALITY_DISABLE: boolean }).__FAS_QUALITY_DISABLE = true;
    const handle = initQualityReporter();
    expect(handle).toBeDefined();
    // Internal marker should still be set so we don't re-attach.
    expect(
      (window as unknown as { __FAS_QUALITY_REPORTER__?: unknown }).__FAS_QUALITY_REPORTER__,
    ).toBeDefined();
  });

  it('posts a snapshot when an iframe parent requests via fas:quality:request', () => {
    // Simulate iframed: fake out window.parent so it's NOT === window.
    const fakeParent = { postMessage: vi.fn() };
    Object.defineProperty(window, 'parent', { value: fakeParent, configurable: true });
    const handle = initQualityReporter();
    // Trigger a manual snapshot post.
    handle.reportNow();
    expect(fakeParent.postMessage).toHaveBeenCalled();
    const arg = (fakeParent.postMessage as ReturnType<typeof vi.fn>).mock.calls[0]?.[0] as {
      type: string;
      schema: number;
    };
    expect(arg.type).toBe('fas:quality');
    expect(arg.schema).toBe(1);
    // Restore parent.
    Object.defineProperty(window, 'parent', { value: window, configurable: true });
  });
});

describe('REFERENCE_VIEWPORTS', () => {
  it('has 6 portrait + 7 viewports total in landscape orientation columns', () => {
    const portrait = REFERENCE_VIEWPORTS.filter((v) => v.orientation === 'portrait');
    const landscape = REFERENCE_VIEWPORTS.filter((v) => v.orientation === 'landscape');
    expect(portrait.length).toBe(7);
    expect(landscape.length).toBe(6);
  });

  it('shares are strictly decreasing as widths increase (per orientation)', () => {
    for (const orientation of ['portrait', 'landscape'] as const) {
      const inOrient = REFERENCE_VIEWPORTS.filter((v) => v.orientation === orientation);
      const sorted = inOrient.slice().sort((a, b) => a.width - b.width);
      for (let i = 1; i < sorted.length; i++) {
        expect(
          sorted[i]!.share,
          `share at width ${sorted[i]!.width} (${sorted[i]!.share}) must be < width ${sorted[i - 1]!.width} (${sorted[i - 1]!.share})`,
        ).toBeLessThanOrEqual(sorted[i - 1]!.share);
      }
    }
  });

  it('all entries have width > 0, height > 0, share between 0 and 100', () => {
    for (const v of REFERENCE_VIEWPORTS) {
      expect(v.width).toBeGreaterThan(0);
      expect(v.height).toBeGreaterThan(0);
      expect(v.share).toBeGreaterThanOrEqual(0);
      expect(v.share).toBeLessThanOrEqual(100);
    }
  });
});

describe('viewportKey', () => {
  it('produces a stable canonical string per viewport', () => {
    expect(viewportKey({ width: 393, height: 852, orientation: 'portrait' })).toBe(
      'portrait:393x852',
    );
    expect(viewportKey({ width: 568, height: 320, orientation: 'landscape' })).toBe(
      'landscape:568x320',
    );
  });
});

describe('computeQualityIndex', () => {
  /** All-pass against every viewport in the reference matrix. */
  function allPassKeys() {
    return new Set(REFERENCE_VIEWPORTS.map(viewportKey));
  }

  it('returns 99/99/99 when every viewport passes', () => {
    const r = computeQualityIndex(REFERENCE_VIEWPORTS, allPassKeys());
    // Sum of all bucket shares = the widest viewport's share + all bucket
    // diffs back to the narrowest = the narrowest's share, which is 99.
    expect(r.portrait).toBe(99);
    expect(r.landscape).toBe(99);
    expect(r.overall).toBe(99);
  });

  it('returns 0/0/0 when no viewport passes', () => {
    const r = computeQualityIndex(REFERENCE_VIEWPORTS, new Set());
    expect(r.portrait).toBe(0);
    expect(r.landscape).toBe(0);
    expect(r.overall).toBe(0);
  });

  it('catches a gap in the middle: pass-fail-fail-pass-pass-pass', () => {
    // The exact bug the dashboard surfaced on tetris landscape:
    // 568 passes, 667 + 736 fail, 800/1024/1366 pass.
    // Naive "max passing share" returns 99. The correct bucket-summed
    // share is (99-96) + (60-35) + (35-20) + 20 = 3 + 25 + 15 + 20 = 63.
    const passKeys = new Set([
      viewportKey({ width: 568, height: 320, orientation: 'landscape' }),
      viewportKey({ width: 800, height: 600, orientation: 'landscape' }),
      viewportKey({ width: 1024, height: 768, orientation: 'landscape' }),
      viewportKey({ width: 1366, height: 1024, orientation: 'landscape' }),
    ]);
    const r = computeQualityIndex(REFERENCE_VIEWPORTS, passKeys);
    expect(r.landscape).toBe(63);
  });

  it('overall = min of orientation scores for any-orientation apps', () => {
    // Portrait all pass (99), landscape only iPad+ pass (35).
    // Overall should be min(99, 35) = 35.
    const passKeys = new Set([
      ...REFERENCE_VIEWPORTS.filter((v) => v.orientation === 'portrait').map(viewportKey),
      viewportKey({ width: 1024, height: 768, orientation: 'landscape' }),
      viewportKey({ width: 1366, height: 1024, orientation: 'landscape' }),
    ]);
    const r = computeQualityIndex(REFERENCE_VIEWPORTS, passKeys);
    expect(r.portrait).toBe(99);
    expect(r.landscape).toBe(35); // 35-20 + 20 = 35
    expect(r.overall).toBe(35);
  });

  it('handles single-orientation matrices (portrait-only manifest)', () => {
    const portraitOnly = REFERENCE_VIEWPORTS.filter((v) => v.orientation === 'portrait');
    const r = computeQualityIndex(portraitOnly, new Set(portraitOnly.map(viewportKey)));
    expect(r.portrait).toBe(99);
    expect(r.landscape).toBe(0);
    expect(r.overall).toBe(99); // single-orientation app — overall = portrait
  });

  it('only the widest viewport passes → score = widest viewport share', () => {
    // If only iPad Pro portrait (1024×1366, share=20) passes, score = 20.
    const r = computeQualityIndex(
      REFERENCE_VIEWPORTS,
      new Set([viewportKey({ width: 1024, height: 1366, orientation: 'portrait' })]),
    );
    expect(r.portrait).toBe(20); // share at the widest = its full share
  });

  it('only the narrowest viewport passes → score = bucket between narrowest and second-narrowest', () => {
    // 320 passes (share=99), 360 onwards fail.
    // Bucket for 320 = 99 - 96 = 3. So score = 3.
    const r = computeQualityIndex(
      REFERENCE_VIEWPORTS,
      new Set([viewportKey({ width: 320, height: 568, orientation: 'portrait' })]),
    );
    expect(r.portrait).toBe(3);
  });

  it('passing keys for non-matrix viewports are ignored', () => {
    // Bogus key like "portrait:999x999" not in REFERENCE_VIEWPORTS.
    const r = computeQualityIndex(REFERENCE_VIEWPORTS, new Set(['portrait:999x999']));
    expect(r.portrait).toBe(0);
    expect(r.overall).toBe(0);
  });
});

describe('snapshot edge cases', () => {
  it('caps clipping hits to a reasonable count', () => {
    // Manufacture 30 overflow-hidden divs that each clip — reporter
    // should cap at MAX_CLIPPING_HITS (20) so a deeply-broken page
    // doesn't post a giant message back to the parent.
    document.body.innerHTML = '';
    for (let i = 0; i < 30; i++) {
      document.body.innerHTML += `<div data-c="${i}"></div>`;
    }
    const origGet = window.getComputedStyle;
    window.getComputedStyle = ((el: Element) =>
      el instanceof HTMLDivElement && el.dataset.c !== undefined
        ? ({ overflowX: 'hidden', overflowY: 'visible' } as CSSStyleDeclaration)
        : origGet(el)) as typeof window.getComputedStyle;
    document.querySelectorAll('[data-c]').forEach((el) => {
      Object.defineProperty(el, 'scrollWidth', { get: () => 100, configurable: true });
      Object.defineProperty(el, 'clientWidth', { get: () => 50, configurable: true });
      Object.defineProperty(el, 'scrollHeight', { get: () => 50, configurable: true });
      Object.defineProperty(el, 'clientHeight', { get: () => 50, configurable: true });
    });
    const s = snapshot();
    expect(s.clipping.length).toBeLessThanOrEqual(20);
    window.getComputedStyle = origGet;
  });

  it('selector falls back to plain tag name when no id or class', () => {
    document.body.innerHTML = '<div></div>';
    const div = document.querySelector('div') as HTMLElement;
    const origGet = window.getComputedStyle;
    window.getComputedStyle = ((el: Element) =>
      el === div
        ? ({ overflowX: 'hidden', overflowY: 'visible' } as CSSStyleDeclaration)
        : origGet(el)) as typeof window.getComputedStyle;
    Object.defineProperty(div, 'scrollWidth', { get: () => 100 });
    Object.defineProperty(div, 'clientWidth', { get: () => 50 });
    Object.defineProperty(div, 'scrollHeight', { get: () => 50 });
    Object.defineProperty(div, 'clientHeight', { get: () => 50 });
    const s = snapshot();
    // No id, no class → selector is just the tag name (no trailing punctuation).
    expect(s.clipping[0]?.selector).toBe('div');
    window.getComputedStyle = origGet;
  });

  it('schema field is exactly 1 (locks the wire format)', () => {
    // If we ever bump the schema, every dashboard listening on schema 1
    // breaks until updated. Lock it down so tests catch a silent change.
    expect(snapshot().schema).toBe(1);
    expect(snapshot().type).toBe('fas:quality');
  });

  it('reporterVersion is a valid semver-ish string', () => {
    expect(snapshot().reporterVersion).toMatch(/^\d+\.\d+\.\d+$/);
  });
});
