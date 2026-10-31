import { readdirSync, readFileSync } from 'node:fs'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import ts from 'typescript'

const src = new URL('../src/', import.meta.url)
test('all admin UI uses utilities, without inline styles or DOM style mutations', () => {
  for (const name of readdirSync(src).filter((name) => name.endsWith('.tsx'))) {
    const text = readFileSync(new URL(name, src), 'utf8')
    const file = ts.createSourceFile(
      name,
      text,
      ts.ScriptTarget.Latest,
      true,
      ts.ScriptKind.TSX,
    )
    const visit = (node) => {
      if (ts.isJsxAttribute(node))
        assert.notEqual(
          node.name.getText(file),
          'style',
          `${name}: inline style`,
        )
      if (ts.isPropertyAccessExpression(node))
        assert.notEqual(node.name.text, 'style', `${name}: DOM style mutation`)
      ts.forEachChild(node, visit)
    }
    visit(file)
    assert.doesNotMatch(
      text,
      /(?:text|bg|border)-\[(?:var\(--|#|rgba?\()/,
      `${name}: long-hand color utility`,
    )
    assert.doesNotMatch(
      text,
      /(?:color|background|border):\s*['"`]/,
      `${name}: style object`,
    )
  }
})

test('theme maps every semantic color and keeps surfaces opaque in both themes', () => {
  const css = readFileSync(new URL('index.css', src), 'utf8')
  assert.match(css, /@theme inline\s*\{/)
  for (const token of [
    'paper',
    'paper-deep',
    'ink',
    'muted',
    'line',
    'line-strong',
    'panel',
    'panel-strong',
    'popover',
    'panel-glass',
    'scrim',
    'accent',
    'accent-soft',
    'accent-deep',
    'success',
    'warning',
    'danger',
  ]) {
    assert.ok(css.includes(`--color-${token}: var(--${token})`), token)
  }
  const themes = [
    ...css.matchAll(/:root(?:\[data-theme='dark'\])?\s*\{([^}]+)\}/g),
  ]
  assert.equal(themes.length, 2)
  for (const [, body] of themes) {
    assert.match(body, /--panel: #[\da-f]{6};/)
    assert.match(body, /--panel-strong: #[\da-f]{6};/)
    assert.match(body, /--popover: var\(--paper\);/)
    assert.match(body, /--panel-glass: rgba\(/)
  }
})
