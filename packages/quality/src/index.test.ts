// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { snapshot, initQualityReporter } from './index.js';

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
