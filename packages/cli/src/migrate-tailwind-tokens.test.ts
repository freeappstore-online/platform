import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { migrateTailwindTokens } from './migrate-tailwind-tokens.js';

// #325: the codemod rewrites long-hand token utilities and resolves banned aliases by the
// app's own definition. Dry-run by default; idempotent.

const TOKENS = `  --paper: #fafafa;
  --ink: #111;
  --muted: #666;
  --line: #ddd;
  --radius: 8px;
`;
const INDEX = `@import "tailwindcss";
@source "../node_modules/@freeappstore/sdk/dist";

:root {
${TOKENS}}
`;

function app(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), 'fas-migrate-'));
  mkdirSync(join(dir, 'web/src'), { recursive: true });
  for (const [f, c] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, 'web/src', f)), { recursive: true });
    writeFileSync(join(dir, 'web/src', f), c);
  }
  return dir;
}
const read = (dir: string, f: string) => readFileSync(join(dir, 'web/src', f), 'utf8');

describe('fas migrate tailwind-tokens (#494)', () => {
  it('rewrites long-hand utilities, keeping variants and opacity, and inserts @theme inline', async () => {
    const dir = app({
      'index.css': `${INDEX.replace(':root {', '@layer base { :root {')}}`,
      'A.tsx': `export const A = () => <div className="hover:text-[var(--muted)] md:border-[var(--line)]/50 rounded-[var(--radius)] bg-[var(--paper)]" />;`,
    });
    const r = await migrateTailwindTokens({ dir, write: true });
    expect(read(dir, 'A.tsx')).toContain(
      'className="hover:text-muted md:border-line/50 rounded-fas bg-paper"',
    );
    expect(r.themeInserted).toBe(true);
    const css = read(dir, 'index.css');
    expect(css).toMatch(/@source [^\n]+\n\n@theme inline \{\n {2}--color-paper: var\(--paper\);/);
    expect(css).toContain('--radius-fas: var(--radius);');
    expect(css).not.toContain('--color-danger');
  });

  it('leaves an unknown token unchanged and reports it', async () => {
    const dir = app({
      'index.css': INDEX,
      'A.tsx': `const c = cn("text-[var(--unknown)] text-[var(--ink)]");`,
    });
    const r = await migrateTailwindTokens({ dir, write: true });
    expect(read(dir, 'A.tsx')).toBe(`const c = cn("text-[var(--unknown)] text-ink");`);
    expect(r.unknownTokens).toEqual({ '--unknown': 1 });
    expect(r.report.join('\n')).toContain('--unknown');
  });

  it('does not touch a bare arbitrary value or CSS-in-JS', async () => {
    const src = `const a = '[var(--ink)]'; const s = { color: 'var(--ink)' }; const t = 'x-text-[var(--ink)]';`;
    const dir = app({ 'index.css': INDEX, 'A.tsx': src });
    await migrateTailwindTokens({ dir, write: true });
    expect(read(dir, 'A.tsx')).toBe(src);
  });

  it("inlines a banned alias by the app's own definition and deletes it", async () => {
    const dir = app({
      'index.css':
        INDEX.replace('}\n', '  --surface: var(--paper);\n}\n') +
        '.x { background: var(--surface); }\n',
      'A.tsx': `const c = cn("bg-[var(--surface)]");`,
    });
    const r = await migrateTailwindTokens({ dir, write: true });
    const css = read(dir, 'index.css');
    expect(css).not.toContain('--surface');
    expect(css).toContain('background: var(--paper);');
    expect(read(dir, 'A.tsx')).toBe(`const c = cn("bg-paper");`);
    expect(r.inlinedAliases).toEqual([{ alias: '--surface', target: '--paper' }]);
  });

  it('reports and skips an alias that resolves differently in light and dark', async () => {
    const css =
      INDEX.replace('}\n', '  --surface: var(--paper);\n}\n') +
      ":root[data-theme='dark'] {\n  --paper: #000;\n  --surface: var(--ink);\n}\n";
    const dir = app({ 'index.css': css, 'A.tsx': `const c = cn("bg-[var(--surface)]");` });
    const r = await migrateTailwindTokens({ dir, write: true });
    expect(read(dir, 'index.css')).toContain('--surface: var(--paper);');
    expect(read(dir, 'A.tsx')).toBe(`const c = cn("bg-[var(--surface)]");`);
    expect(r.skippedAliases).toEqual([
      { alias: '--surface', reason: 'resolves to --paper in light but --ink in dark' },
    ]);
  });

  it('is a dry run by default and idempotent when written', async () => {
    const files = { 'index.css': INDEX, 'A.tsx': `const c = cn("text-[var(--muted)]");` };
    const dir = app(files);
    const dry = await migrateTailwindTokens({ dir, write: false });
    expect(dry.replacements).toBeGreaterThan(0);
    expect(dry.changes.find((c) => c.file === 'web/src/A.tsx')!.diff).toContain(
      '+const c = cn("text-muted");',
    );
    expect(read(dir, 'A.tsx')).toBe(files['A.tsx']);
    expect(read(dir, 'index.css')).toBe(INDEX);
    await migrateTailwindTokens({ dir, write: true });
    const again = await migrateTailwindTokens({ dir, write: true });
    expect(again.changes).toEqual([]);
  });

  it('reports unlayered rules, hex and dark overrides it cannot fix', async () => {
    const css =
      INDEX +
      `.card { color: #abc; }\n@layer base { body { margin: 0; } }\n:root[data-theme='dark'] .card { color: red; }\n`;
    const dir = app({ 'index.css': css });
    const r = await migrateTailwindTokens({ dir, write: false });
    const text = r.report.join('\n');
    expect(text).toMatch(/unlayered rule/);
    expect(text).toMatch(/hex value/);
    expect(text).toMatch(/dark override/);
  });

  it('errors without web/src', async () => {
    await expect(
      migrateTailwindTokens({ dir: mkdtempSync(join(tmpdir(), 'fas-migrate-')), write: false }),
    ).rejects.toThrow(/web\/src/);
  });

  it('leaves unrelated strings and comments unchanged, but rewrites class templates', async () => {
    const source =
      // biome-ignore lint/suspicious/noTemplateCurlyInString: source fixture contains a template literal
      'const raw = "text-[var(--ink)]"; // text-[var(--ink)]\nconst A = <div className={cn(`hover:text-[var(--ink)] ${ok ? "bg-[var(--paper)]" : ""}`)} style={{color: "var(--ink)"}} />;';
    const dir = app({ 'index.css': INDEX, 'A.tsx': source });
    const r = await migrateTailwindTokens({ dir, write: true });
    expect(read(dir, 'A.tsx')).toContain('const raw = "text-[var(--ink)]"; // text-[var(--ink)]');
    expect(read(dir, 'A.tsx')).toContain('hover:text-ink');
    expect(read(dir, 'A.tsx')).toContain('bg-paper');
    expect(r.report.join(' ')).toContain('1 inline-style');
  });
  it('handles glass/dock aliases and reports cycles without deleting them', async () => {
    const dir = app({
      'index.css': `${INDEX}:root { --glass: var(--paper); --dock: var(--glass); --bg: var(--surface); --surface: var(--bg); }`,
      'A.tsx': 'const A = <div className="bg-[var(--dock)]" />;',
    });
    const r = await migrateTailwindTokens({ dir, write: true });
    expect(read(dir, 'A.tsx')).toContain('bg-paper');
    expect(read(dir, 'index.css')).toContain('--bg: var(--surface)');
    expect(r.skippedAliases).toHaveLength(2);
  });
  it('fills a partial theme and preserves conflicting mappings', async () => {
    const dir = app({
      'index.css': `${INDEX}@theme inline { --color-ink: var(--paper); }`,
      'A.tsx': '<div className="text-[var(--ink)] text-[var(--muted)]" />',
    });
    await migrateTailwindTokens({ dir, write: true });
    expect(read(dir, 'A.tsx')).toContain('text-[var(--ink)] text-muted');
    expect((await migrateTailwindTokens({ dir, write: true })).changes).toEqual([]);
  });
  it('does not rewrite utilities without a Tailwind import or source anchor', async () => {
    const dir = app({
      'index.css': ':root { --ink: #111; }',
      'A.tsx': '<div className="text-[var(--ink)]" />',
    });
    await migrateTailwindTokens({ dir, write: true });
    expect(read(dir, 'A.tsx')).toContain('text-[var(--ink)]');
  });
});
