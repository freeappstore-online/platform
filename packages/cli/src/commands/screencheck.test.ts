import { describe, it, expect } from 'vitest';
import { pickMatrix, computeCoverage } from './screencheck.js';

describe('pickMatrix', () => {
  it('returns 6 portrait + 6 landscape sizes for orientation=any', () => {
    const m = pickMatrix(320, 'any');
    expect(m).toHaveLength(12);
    expect(m.filter((t) => t.orientation === 'portrait')).toHaveLength(6);
    expect(m.filter((t) => t.orientation === 'landscape')).toHaveLength(6);
  });

  it('returns only portrait sizes for orientation=portrait', () => {
    const m = pickMatrix(320, 'portrait');
    expect(m).toHaveLength(6);
    expect(m.every((t) => t.orientation === 'portrait')).toBe(true);
  });

  it('returns only landscape sizes for orientation=landscape', () => {
    const m = pickMatrix(320, 'landscape');
    expect(m).toHaveLength(6);
    expect(m.every((t) => t.orientation === 'landscape')).toBe(true);
  });

  it('treats missing/unknown orientation as any', () => {
    expect(pickMatrix(320, '')).toHaveLength(12);
    expect(pickMatrix(320, 'unspecified')).toHaveLength(12);
  });

  it('shares are cumulative — smaller width = higher share', () => {
    const m = pickMatrix(320, 'portrait');
    const widths = m.map((t) => t.width);
    expect(widths).toEqual([320, 360, 414, 600, 768, 1024]);
    // 320 should have the highest share (almost everyone)
    expect(m[0].share).toBeGreaterThan(m[m.length - 1].share);
  });
});

describe('computeCoverage', () => {
  it('full pass = full coverage on smallest size', () => {
    const m = pickMatrix(320, 'any');
    const passing = new Set(m.map((t) => t.label));
    const c = computeCoverage(m, passing);
    expect(c.portrait).toBe(99);
    expect(c.landscape).toBe(99);
    expect(c.overall).toBe(99);
    expect(c.brokenSizes).toHaveLength(0);
  });

  it('partial pass — only desktop sizes pass', () => {
    const m = pickMatrix(320, 'any');
    // Desktop-only: only the 600+ portraits and 800+ landscapes pass
    const passing = new Set(
      m
        .filter(
          (t) =>
            (t.orientation === 'portrait' && t.width >= 1024) ||
            (t.orientation === 'landscape' && t.width >= 800),
        )
        .map((t) => t.label),
    );
    const c = computeCoverage(m, passing);
    expect(c.portrait).toBe(20); // 1024px portrait → ~20%
    expect(c.landscape).toBe(60); // 800px landscape → ~60%
    expect(c.overall).toBe(20); // min of the two
  });

  it('overall is min of orientation coverages for any-orientation apps', () => {
    const m = pickMatrix(320, 'any');
    const passing = new Set(
      m.filter((t) => t.orientation === 'landscape').map((t) => t.label),
    );
    const c = computeCoverage(m, passing);
    expect(c.portrait).toBe(0);
    expect(c.landscape).toBe(99);
    expect(c.overall).toBe(0);
  });

  it('overall = single orientation when manifest restricts orientation', () => {
    const m = pickMatrix(320, 'portrait');
    const passing = new Set(m.map((t) => t.label));
    const c = computeCoverage(m, passing);
    expect(c.overall).toBe(99);
  });

  it('reports broken sizes', () => {
    const m = pickMatrix(320, 'portrait');
    const passing = new Set(m.filter((t) => t.width >= 600).map((t) => t.label));
    const c = computeCoverage(m, passing);
    expect(c.brokenSizes).toHaveLength(3);
    expect(c.brokenSizes.map((t) => t.width)).toEqual([320, 360, 414]);
  });
});
