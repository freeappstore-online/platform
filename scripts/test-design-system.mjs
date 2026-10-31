// Run: node --test scripts/test-design-system.mjs

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

const doc = readFileSync(new URL('../DESIGN-SYSTEM.md', import.meta.url), 'utf8');
const section = doc.split('## 6.')[1].split('## 7.')[0];
const mapping = section.match(/@theme inline \{([\s\S]*?)\n\}/)[1];

test('every documented colour token has a live Tailwind mapping', () => {
  const tables = doc.split('### Shape')[0];
  const tokens = [...tables.matchAll(/^\| `(--[\w-]+)` \|/gm)].map((m) => m[1]);
  assert.ok(tokens.length >= 19);
  for (const token of tokens) {
    assert.ok(mapping.includes(`--color-${token.slice(2)}: var(${token});`), token);
  }
});

test('mapping contains no circular references or frozen colour values', () => {
  const declarations = [...mapping.matchAll(/(--[\w-]+): var\((--[\w-]+)\);/g)];
  assert.ok(declarations.length >= 27);
  for (const [, target, source] of declarations) assert.notEqual(target, source);
  assert.doesNotMatch(mapping, /#[\da-f]{3,8}\b/i);
  assert.doesNotMatch(section, /export default|theme:\s*\{/);
});

test('surface defaults remain opaque and glass is explicitly separate', () => {
  for (const token of ['paper', 'panel']) {
    const row = doc.match(new RegExp(`^\\| \x60--${token}\x60 \\| (.*)$`, 'm'))[1];
    const values = [...row.matchAll(/`([^`]+)`/g)].map((m) => m[1]);
    assert.equal(values.length, 2);
    for (const value of values) assert.match(value, /^#[\da-f]{6}$/i);
  }
  assert.match(doc, /\| `--popover` \| `var\(--paper\)` \| `var\(--paper\)` \|/);
  assert.match(doc, /alpha = 1 in both themes/);
  assert.match(doc, /glass token is optional/);
  assert.match(doc, /`--panel-glass` with `backdrop-filter`/);
  assert.doesNotMatch(doc, /`--panel` \+ opacity|rename `--glass\/\*`/);
});

test('styling and enforcement cover SDK and platform UI', () => {
  const model = doc.split('## 0.5 Styling model')[1].split('## 1.')[0];
  for (const term of [
    'Tailwind 4',
    'SDK Shell',
    'console',
    'admin',
    'Components',
    '@layer base',
    '@layer components',
    'dynamic values',
    'No runtime-injected CSS',
  ]) {
    assert.ok(model.includes(term), term);
  }
  assert.match(doc, /`css-discipline`/);
  assert.match(doc, /`opaque-surface`/);
  assert.match(doc, /hamburger-triggered dropdown/);
  assert.doesNotMatch(doc, /Apps using Tailwind|add preset|### 2\. Vendored preset/);
});

test('FAS documentation and CI use the platform-local contract', () => {
  for (const surface of [
    'packages/sdk/src/ui',
    'sites/console',
    'sites/storefront',
    'workers/admin',
  ]) {
    assert.ok(doc.includes(surface), surface);
  }
  const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
  assert.ok(read('docs/ui.md').includes('/DESIGN-SYSTEM.md'));
  assert.ok(
    read('.github/workflows/ci.yml').includes('node --test scripts/test-design-system.mjs'),
  );
});
