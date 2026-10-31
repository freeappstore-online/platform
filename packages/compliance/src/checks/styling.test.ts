import { describe, expect, it } from 'vitest';
import { mapFileSource } from '../lib/file-source.js';
import { checkCssDiscipline } from './css-discipline.js';
import { checkNoExcessiveInlineStyles } from './no-excessive-inline-styles.js';
import { checkOpaqueSurface } from './opaque-surface.js';

const cssSource = (css: string) => mapFileSource(new Map([['web/src/index.css', css]]));

describe('CSS discipline passing/failing fixtures', () => {
  it.each([
    [
      'banned-alias',
      ':root { --panel: #fff } @layer base { body { color: var(--ink) } }',
      ':root { --surface: #fff }',
    ],
    ['unlayered-rule', '@layer components { .card { padding: 1rem } }', '.card { padding: 1rem }'],
    [
      'hex-outside-tokens',
      ':root { --accent: #c84a00 }',
      '@layer base { body { color: #c84a00 } }',
    ],
    [
      'per-screen-dark-override',
      ':root[data-theme="dark"] { --paper: #000 }',
      '@layer components { [data-theme="dark"] .card { color: var(--ink) } }',
    ],
    [
      'feature-classes',
      `@layer components { ${Array.from({ length: 15 }, (_, i) => `.c${i}{color:var(--ink)}`).join('')} }`,
      `@layer components { ${Array.from({ length: 16 }, (_, i) => `.c${i}{color:var(--ink)}`).join('')} }`,
    ],
  ])('%s has a passing and failing fixture', async (rule, passing, failing) => {
    expect((await checkCssDiscipline(cssSource(passing))).status).toBe('pass');
    const result = await checkCssDiscipline(cssSource(failing));
    expect(result.status).toBe('warn');
    expect(result.detail).toContain(rule);
  });

  it('parses nested CSS, print, keyframes, @theme and comments', async () => {
    expect(
      (
        await checkCssDiscipline(
          cssSource(`
      /* .dark .bad { color: #fff; --bg: red } */
      @theme inline { --color-paper: var(--paper); }
      @layer components { .card { &:hover { color: var(--accent) } } }
      @media print { body { display: block } }
      @keyframes fade { from { opacity: 0 } to { opacity: 1 } }
    `),
        )
      ).status,
    ).toBe('pass');
  });

  it('warns on malformed CSS instead of crashing the compliance run', async () => {
    expect((await checkCssDiscipline(cssSource('body {'))).detail).toContain('css-parse');
  });

  it('flags per-screen dark media overrides but allows central dark token blocks', async () => {
    const result = await checkCssDiscipline(
      cssSource(
        '@media (prefers-color-scheme: dark) { :root { --paper: #000 } @layer components { .card { color: var(--ink) } } }',
      ),
    );
    expect(result.detail).toContain('per-screen-dark-override: .card');
    expect(result.detail).not.toContain('per-screen-dark-override: :root');
  });

  it('finds aliases used with fallbacks, and does not flag compound tokens', async () => {
    expect(
      (await checkCssDiscipline(cssSource('@layer base { body { color: var( --error, red) } }')))
        .detail,
    ).toContain('banned-alias');
    expect(
      (await checkCssDiscipline(cssSource(':root { --panel-glass: #fff8; --icon-bg: red }')))
        .status,
    ).toBe('pass');
  });
});

describe('opaque surfaces', () => {
  it.each([
    'transparent',
    '#fff8',
    '#ffffff80',
    'rgba(255,255,255,0.72)',
    'rgb(0 0 0 / 90%)',
    'hsl(0 0% 0% / .5)',
    'hsla(0,0%,0%,0.8)',
    'oklch(50% .1 30 / 0.7)',
  ])('warns for %s in every floating surface token', async (colour) => {
    for (const token of ['paper', 'panel', 'popover']) {
      const result = await checkOpaqueSurface(
        cssSource(`:root[data-theme='dark'] { --${token}: ${colour}; }`),
      );
      expect(result.status).toBe('warn');
      expect(result.detail).toContain(`--${token}`);
    }
  });
  it.each([
    '#fff',
    '#ffff',
    '#ffffffff',
    'rgb(0 0 0)',
    'rgb(0 0 0 / 100%)',
    'rgba(0,0,0,1)',
    'var(--paper)',
  ])('passes opaque %s', async (colour) => {
    expect(
      (
        await checkOpaqueSurface(
          cssSource(`:root { --panel: ${colour}; --panel-glass: #fff8; --scrim: #0008 }`),
        )
      ).status,
    ).toBe('pass');
  });
  it('ignores commented surfaces', async () => {
    expect((await checkOpaqueSurface(cssSource('/* :root { --panel: #fff8 } */'))).status).toBe(
      'pass',
    );
  });
});

describe('FGS inline style thresholds with FAS guidance', () => {
  const inline = (count: number) => '<div style={{ color: "red" }} />;\n'.repeat(count);
  it.each([
    [15, 15, 'pass'],
    [16, 0, 'warn'],
    [15, 15, 'pass'],
    [15, 16, 'warn'],
  ])('counts %i + %i as %s', async (a, b, status) => {
    const result = await checkNoExcessiveInlineStyles(
      mapFileSource(
        new Map([
          ['web/src/A.tsx', inline(Number(a))],
          ['web/src/B.tsx', inline(Number(b))],
        ]),
      ),
    );
    expect(result.status).toBe(status);
    if (status === 'warn') expect(result.suggestions?.join(' ')).toContain('FAS:');
  });
  it('warns above 30 total even when no file exceeds 15', async () => {
    const files = new Map(Array.from({ length: 3 }, (_, i) => [`web/src/${i}.tsx`, inline(11)]));
    expect((await checkNoExcessiveInlineStyles(mapFileSource(files))).status).toBe('warn');
  });
  it('ignores tests, non-app files, strings and comments', async () => {
    expect(
      (
        await checkNoExcessiveInlineStyles(
          mapFileSource(
            new Map([
              ['web/src/A.test.tsx', inline(100)],
              ['web/src/__tests__/A.tsx', inline(100)],
              ['other/A.tsx', inline(100)],
              ['web/src/A.tsx', `/* ${inline(100)} */ const example = 'style={{}}';`],
            ]),
          ),
        )
      ).status,
    ).toBe('pass');
  });
});
