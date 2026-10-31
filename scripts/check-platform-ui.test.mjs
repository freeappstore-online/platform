import assert from 'node:assert/strict';
import { test } from 'node:test';
import { scanRuntimeStyles } from './check-platform-ui.mjs';

test('counts runtime styles and ignores comments and example strings', () => {
  assert.deepEqual(
    scanRuntimeStyles(
      `
    // const BAD_CSS = \`a { color: red }\`;
    const example = 'style={{ color: "red" }}';
    const x = <div style={{ color: 'red' }} />;
    const BAD_CSS = \`a { color: red }\`;
    style.textContent = BAD_CSS;
  `,
      'fixture.tsx',
    ),
    { inline: 1, uncommented: 1, injection: 2 },
  );
});

test('accepts a documented dynamic value and ordinary textContent', () => {
  assert.deepEqual(
    scanRuntimeStyles(
      `
    // Dynamic progress width depends on the current value.
    const x = <div style={{ width: progress }} />;
    label.textContent = 'Hello';
  `,
      'fixture.tsx',
    ),
    { inline: 1, uncommented: 0, injection: 0 },
  );
});

test('detects direct CSS assignment and interpolated CSS constants', () => {
  assert.equal(scanRuntimeStyles('el.textContent = "body { color: red }";', 'x.ts').injection, 1);
  assert.equal(
    scanRuntimeStyles('const MODAL_CSS = `body { color: ${color} }`;', 'x.ts').injection,
    1,
  );
});
