import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { fsFileSource } from '../lib/file-source.js';
import { checkNoBrandOverrides, scanContent } from './no-brand-overrides.js';

async function fixture(files: Record<string, string>): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'fas-brand-'));
  for (const [path, content] of Object.entries(files)) {
    const full = join(dir, path);
    await mkdir(join(full, '..'), { recursive: true });
    await writeFile(full, content);
  }
  return dir;
}

describe('scanContent (unit)', () => {
  it('flags an override of a protected CSS variable', () => {
    const issues = scanContent(
      'web/src/index.css',
      `
      :root { --accent: hotpink; }
    `,
    );
    expect(issues).toHaveLength(1);
    expect(issues[0]).toMatch(/--accent/);
  });

  it('does NOT flag using the variable via var()', () => {
    const issues = scanContent(
      'web/src/App.tsx',
      `
      <div style={{ color: 'var(--accent)' }} />
    `,
    );
    expect(issues).toEqual([]);
  });

  it('does not flag a non-protected custom variable (apps can have their own)', () => {
    const issues = scanContent(
      'web/src/index.css',
      `
      :root { --my-shadow: 0 0 4px black; }
    `,
    );
    expect(issues).toEqual([]);
  });

  it('flags a non-brand font-family in CSS', () => {
    const issues = scanContent(
      'web/src/index.css',
      `
      h1 { font-family: "Cormorant Garamond", serif; }
    `,
    );
    expect(issues).toHaveLength(1);
    expect(issues[0]).toMatch(/cormorant garamond/);
  });

  it('flags a non-brand font in inline JSX styles', () => {
    const issues = scanContent(
      'web/src/App.tsx',
      `
      <h1 style={{ fontFamily: "Sora, sans-serif" }} />
    `,
    );
    expect(issues).toHaveLength(1);
    expect(issues[0]).toMatch(/sora/);
  });

  it('does not consume sibling JSX style props when scanning fontFamily value', () => {
    // Regression: previously matched through the `,` separator into `color:`
    // and tried to validate `"var(--success)"` as a font-family token.
    const issues = scanContent(
      'web/src/App.tsx',
      `
      <h2 style={{ fontFamily: "Fraunces, serif", color: "var(--success)" }} />
    `,
    );
    expect(issues).toEqual([]);
  });

  it('handles a JSX ternary fontFamily without false-positiving on the predicate', () => {
    // Regression: the prefix `isGiven ?` used to be parsed as a font name
    // because the opening quote in the regex was optional.
    const issues = scanContent(
      'web/src/App.tsx',
      `
      const s = { fontFamily: isGiven ? "Fraunces, serif" : "Manrope, system-ui, sans-serif" };
    `,
    );
    expect(issues).toEqual([]);
  });

  it('flags a non-brand branch inside a ternary fontFamily', () => {
    const issues = scanContent(
      'web/src/App.tsx',
      `
      const s = { fontFamily: isGiven ? "Cormorant Garamond" : "Manrope" };
    `,
    );
    expect(issues).toHaveLength(1);
    expect(issues[0]).toMatch(/cormorant garamond/);
  });

  it('accepts brand fonts and system fallbacks', () => {
    const issues = scanContent(
      'web/src/index.css',
      `
      body { font-family: "Manrope", system-ui, sans-serif; }
      h1 { font-family: Fraunces, Georgia, serif; }
      code { font-family: "SF Mono", Menlo, monospace; }
    `,
    );
    expect(issues).toEqual([]);
  });

  it('reports line numbers', () => {
    const issues = scanContent('web/src/index.css', `\n\n:root { --paper: red; }\n`);
    expect(issues[0]).toMatch(/:3 /);
  });

  it('does NOT false-positive on SVG-in-template-literal `font-family="..."`', () => {
    // Regression: a JS template literal generating SVG markup uses
    // `font-family="Georgia,serif"` as an SVG attribute. Earlier the
    // CSS-style slicer would read past the value into adjacent
    // attributes (`font-size="280"`, `fill="rgba(...)"`) and flag those
    // numeric / color strings as "fonts". The fix: only kebab-case
    // `font-family:` (with colon) matches; the equals form is skipped
    // since it almost always appears inside string templates.
    const issues = scanContent(
      'web/src/lib/seed.ts',
      'export const svg = `<text font-family="Georgia,serif" font-size="280" fill="rgba(0,0,0,0.5)">x</text>`;',
    );
    expect(issues).toEqual([]);
  });
});

describe('checkNoBrandOverrides (integration)', () => {
  it('passes when all CSS uses brand tokens', async () => {
    const dir = await fixture({
      'web/src/index.css': `
        :root { --my-extra: 4px; }
        body { font-family: Manrope, system-ui, sans-serif; }
        h1 { font-family: Fraunces, serif; color: var(--accent); }
      `,
    });
    const r = await checkNoBrandOverrides(fsFileSource(dir));
    expect(r.status).toBe('pass');
  });

  it('fails when an app overrides a protected variable in a non-theme CSS file', async () => {
    // web/src/index.css is the canonical theme file (exempt). Per-component
    // CSS like this isn't.
    const dir = await fixture({
      'web/src/components/Branding.css': `:root { --accent: deeppink; }`,
    });
    const r = await checkNoBrandOverrides(fsFileSource(dir));
    expect(r.status).toBe('fail');
    expect(r.detail).toMatch(/override/);
    expect(r.suggestions?.join(' ')).toMatch(/var\(--accent\)/);
  });

  it('does NOT fail when web/src/index.css legitimately defines tokens (template-owned)', async () => {
    const dir = await fixture({
      'web/src/index.css': `:root { --paper: #ffffff; --ink: #1a1a1a; --accent: #2563eb; }`,
    });
    const r = await checkNoBrandOverrides(fsFileSource(dir));
    expect(r.status).toBe('pass');
  });

  it('fails when an app uses non-brand fonts', async () => {
    const dir = await fixture({
      'web/src/App.tsx': `
        const h1 = <h1 style={{ fontFamily: "Cormorant Garamond, serif" }} />;
      `,
    });
    const r = await checkNoBrandOverrides(fsFileSource(dir));
    expect(r.status).toBe('fail');
  });

  // --- comment-stripping regression guards ---

  it('does NOT flag a font-family mention inside a // comment', async () => {
    const dir = await fixture({
      'web/src/App.tsx': '// font-family: "Comic Sans" — used to be here\nexport {};',
    });
    const r = await checkNoBrandOverrides(fsFileSource(dir));
    expect(r.status).toBe('pass');
  });

  it('does NOT flag a CSS-variable override inside a /* CSS comment */', async () => {
    const dir = await fixture({
      'web/src/components/Card.css': '/* :root { --accent: hotpink; } — old palette */ .card {}',
    });
    const r = await checkNoBrandOverrides(fsFileSource(dir));
    expect(r.status).toBe('pass');
  });
});

describe('font custom properties (#310)', () => {
  it.each([
    [
      'Tailwind theme',
      "@theme { --font-body: 'Manrope', sans-serif; } body { font-family: var(--font-body); }",
    ],
    [
      'forward alias',
      ':root { --body: var(--base); --base: Manrope; } body { font-family: var(--body), Arial; }',
    ],
    [
      'nested fallback',
      'body { font-family: var(--missing, var(--also-missing, Manrope)), sans-serif; }',
    ],
    [
      'quoted fallback stack',
      'body { font-family: var(--missing, "Manrope", Arial), sans-serif; }',
    ],
    [
      'cycle with usage fallback',
      ':root { --a: var(--b); --b: var(--a); } body { font-family: var(--a, Manrope); }',
    ],
    [
      'all brand alternatives',
      ':root { --body: Manrope; } .dark { --body: Fraunces; } body { font-family: var(--body); }',
    ],
    [
      'multiline declaration',
      ':root { --body:\n "Manrope",\n sans-serif; } body { font-family: var(--body); }',
    ],
    [
      'case-sensitive missing variable fallback',
      ':root { --Body: "Comic Sans"; } body { font-family: var(--body, Manrope); }',
    ],
  ])('accepts %s', (_name, css) => {
    expect(scanContent('web/src/index.css', css)).toEqual([]);
  });

  it.each([
    [
      'non-brand variable',
      ':root { --body: "Comic Sans", serif; } body { font-family: var(--body); }',
    ],
    [
      'defined variable wins over fallback',
      ':root { --body: Sora; } body { font-family: var(--body, Manrope); }',
    ],
    ['empty variable', ':root { --body: ; } body { font-family: var(--body); }'],
    [
      'connected cycles',
      ':root { --a: var(--b); --b: var(--c); --c: var(--a); --d: var(--c, Manrope); --a: var(--d); } body { font-family: var(--d); }',
    ],
    ['missing variable', 'body { font-family: var(--unknown); }'],
    [
      'cycle without fallback',
      ':root { --a: var(--b); --b: var(--a); } body { font-family: var(--a); }',
    ],
    [
      'fallback inside cycle',
      ':root { --a: var(--b, Manrope); --b: var(--a); } body { font-family: var(--a); }',
    ],
    [
      'non-brand shadow',
      ':root { --body: Manrope; } .dark { --body: Sora; } body { font-family: var(--body); }',
    ],
    ['mixed quoted stack', ':root { --body: Sora; } body { font-family: var(--body), "Manrope"; }'],
    [
      'literal function-shaped name',
      ':root { --body: Manrope; } body { font-family: "var(--body)"; }',
    ],
    ['non-font variable', ':root { --body: #ffffff; } body { font-family: var(--body); }'],
  ])('rejects %s', (_name, css) => {
    expect(scanContent('web/src/index.css', css)).toHaveLength(1);
  });

  it('resolves theme declarations for JSX and per-component CSS regardless of file order', async () => {
    const dir = await fixture({
      'web/src/App.tsx': `const style = { fontFamily: "var(--body), sans-serif" };`,
      'web/src/card.css': 'h1 { font-family: var(--heading); }',
      'web/src/index.css':
        '@theme { --body: Manrope; --heading: var(--display); --display: Fraunces; }',
    });
    expect((await checkNoBrandOverrides(fsFileSource(dir))).status).toBe('pass');
    await writeFile(
      join(dir, 'web/src/card.css'),
      '.card { --body: Sora; font-family: var(--body); }',
    );
    const result = await checkNoBrandOverrides(fsFileSource(dir));
    expect(result.status).toBe('fail');
    expect(result.suggestions?.join(' ')).toContain('non-brand font "sora"');
  });
});
