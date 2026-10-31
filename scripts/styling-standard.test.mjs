import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
const expect = (actual) => ({
  toContain: (value) => assert.ok(actual.includes(value), `Missing: ${value}`),
  toMatch: (pattern) => assert.match(actual, pattern),
  not: { toMatch: (pattern) => assert.doesNotMatch(actual, pattern) },
});

const read = (path) => readFileSync(fileURLToPath(new URL('../' + path, import.meta.url)), 'utf8');
const adr = 'docs/adr/001-tailwind-on-fas-tokens.md';

describe('FAS styling standard (#320)', () => {
  for (const path of [adr, 'docs/ui.md', 'sites/storefront/SKILLS.md']) {
    it(`${path} covers every surface and the dynamic-only exception`, () => {
      const text = read(path);
      for (const surface of ['packages/sdk/src/ui', 'sites/console', 'workers/admin']) {
        expect(text).toContain(surface);
      }
      expect(text).toMatch(/required for every React surface/);
      expect(text).toContain('Never add feature classes to index.css');
      expect(text).toMatch(/Never inline `style` except for truly dynamic values/);
      expect(text).toContain('Runtime-injected CSS strings are prohibited');
      expect(text).toContain('@theme inline');
      expect(text).toContain('--popover: var(--paper)');
      expect(text).toMatch(/Branding stays in token values/);
      expect(text).not.toMatch(/Tailwind[^.\n]*(?:optional|not required)|caller-supplied appearance/i);
    });
  }

  it('publishes named utilities backed by the UI token mapping', () => {
    const ui = read('docs/ui.md');
    const guide = read('sites/storefront/SKILLS.md');
    for (const token of ['paper', 'ink', 'muted', 'line', 'panel', 'popover', 'accent', 'danger']) {
      expect(ui).toContain(`--color-${token}: var(--${token})`);
      expect(guide).toContain(`--${token}`);
    }
    expect(ui).toContain('@source "../node_modules/@freeappstore/sdk/dist"');
    expect(ui).toContain('@source "../../node_modules/@freeappstore/sdk/dist"');
  });

  it('links agent guidance and lint diagnostics to the local standard', () => {
    for (const path of ['CLAUDE.md', 'docs/ui.md', 'sites/storefront/SKILLS.md']) {
      expect(read(path)).toContain('adr/001-tailwind-on-fas-tokens.md');
    }
    expect(read('CLAUDE.md')).toContain('All UI, including the SDK, is React + Tailwind 4 on tokens');
    expect(read('scripts/check-design-system.sh')).toContain('docs/ui.md#styling');
  });
});
