import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { REFERENCE_VIEWPORTS } from '@freeappstore/quality';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { pathLookupCommand } from '../one-shot/doctor.js';
import { blockingFailures, computeCoverage, pickMatrix, readManifest } from './screencheck.js';

describe('pickMatrix', () => {
  it('is the /quality dashboard matrix (#281)', () => {
    const m = pickMatrix(320, 'any');
    expect(m.map((t) => `${t.orientation}:${t.width}x${t.height}@${t.share}`)).toEqual(
      REFERENCE_VIEWPORTS.map((r) => `${r.orientation}:${r.width}x${r.height}@${r.share}`),
    );
    expect(m.filter((t) => t.orientation === 'portrait')).toHaveLength(7);
    expect(m.filter((t) => t.orientation === 'landscape')).toHaveLength(6);
  });

  it('returns only portrait sizes for orientation=portrait', () => {
    const m = pickMatrix(320, 'portrait');
    expect(m).toHaveLength(7);
    expect(m.every((t) => t.orientation === 'portrait')).toBe(true);
  });

  it('returns only landscape sizes for orientation=landscape', () => {
    const m = pickMatrix(320, 'landscape');
    expect(m).toHaveLength(6);
    expect(m.every((t) => t.orientation === 'landscape')).toBe(true);
  });

  it('treats missing/unknown orientation as any', () => {
    expect(pickMatrix(320, '')).toHaveLength(13);
    expect(pickMatrix(320, 'unspecified')).toHaveLength(13);
  });

  it('shares are cumulative — smaller width = higher share', () => {
    const m = pickMatrix(320, 'portrait');
    const widths = m.map((t) => t.width);
    expect(widths).toEqual([320, 360, 393, 414, 600, 768, 1024]);
    // 320 should have the highest share (almost everyone)
    expect(m[0]!.share).toBeGreaterThan(m[m.length - 1]!.share);
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
    const passing = new Set(m.filter((t) => t.orientation === 'landscape').map((t) => t.label));
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
    expect(c.brokenSizes).toHaveLength(4);
    expect(c.brokenSizes.map((t) => t.width)).toEqual([320, 360, 393, 414]);
  });

  // #281: the old max-share math called this ~99%; the dashboard says ~3%.
  it('an app that fits only at 320px covers ~3%, matching the dashboard', () => {
    const m = pickMatrix(320, 'portrait');
    const c = computeCoverage(m, new Set(m.filter((t) => t.width === 320).map((t) => t.label)));
    expect(c.portrait).toBe(3);
  });
});

describe('blockingFailures (#281)', () => {
  const m = pickMatrix(320, 'portrait');
  const passingExcept = (...widths: number[]) =>
    new Set(m.filter((t) => !widths.includes(t.width)).map((t) => t.label));

  it('fails on any handheld width at or above the declared minimum', () => {
    expect(blockingFailures(m, passingExcept(414, 600), 360).map((t) => t.width)).toEqual([
      414, 600,
    ]);
  });

  it('fails with a 375px minimum even though no test width equals it', () => {
    expect(blockingFailures(m, new Set(), 375).map((t) => t.width)).toEqual([393, 414, 600, 768]);
  });

  it("doesn't fail below the declared minimum or at desktop widths only", () => {
    expect(blockingFailures(m, passingExcept(320, 1024), 360)).toEqual([]);
  });

  it('counts desktop widths when the declared minimum is that wide', () => {
    expect(blockingFailures(m, passingExcept(1024), 1024).map((t) => t.width)).toEqual([1024]);
  });
});

describe('readManifest (#281)', () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'fas-screencheck-'));
    await mkdir(join(dir, 'web', 'public'), { recursive: true });
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('reads web/public/manifest.json', async () => {
    await writeFile(
      join(dir, 'web', 'public', 'manifest.json'),
      JSON.stringify({ orientation: 'portrait', min_viewport_width: 360 }),
    );
    expect(await readManifest(dir)).toMatchObject({
      orientation: 'portrait',
      min_viewport_width: 360,
    });
  });

  it('falls back to an inline VitePWA manifest', async () => {
    await writeFile(
      join(dir, 'web', 'vite.config.ts'),
      "import { VitePWA } from 'vite-plugin-pwa';\nexport default { plugins: [VitePWA({ manifest: { name: 'G', orientation: 'landscape', min_viewport_width: 568 } })] };",
    );
    expect(await readManifest(dir)).toMatchObject({
      orientation: 'landscape',
      min_viewport_width: 568,
    });
  });

  it('returns null with neither', async () => {
    expect(await readManifest(dir)).toBeNull();
  });
});

describe('pathLookupCommand (#281)', () => {
  it('uses where on Windows and which elsewhere', () => {
    expect(pathLookupCommand('win32')).toBe('where');
    expect(pathLookupCommand('darwin')).toBe('which');
    expect(pathLookupCommand('linux')).toBe('which');
  });
});
