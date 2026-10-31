import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

/** Inspect syntax so a comment cannot hide a static style or CSS injection. */
function violations(source: string, filename = 'component.tsx'): string[] {
  const tree = ts.createSourceFile(
    filename,
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TSX,
  );
  const errors: string[] = [];
  function visit(node: ts.Node) {
    if (ts.isVariableDeclaration(node) && /_CSS$/.test(node.name.getText(tree))) {
      errors.push('CSS string');
    }
    if (
      ts.isCallExpression(node) &&
      /(?:createElement|createElementNS)$/.test(node.expression.getText(tree)) &&
      node.arguments.some((arg) => ts.isStringLiteral(arg) && arg.text === 'style')
    ) {
      errors.push('style injection');
    }
    if (
      ts.isBinaryExpression(node) &&
      node.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
      /(?:textContent|innerHTML|cssText)$/.test(node.left.getText(tree))
    ) {
      errors.push('CSS/HTML injection');
    }
    if (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) {
      if (node.tagName.getText(tree) === 'style') errors.push('style element');
      for (const attr of node.attributes.properties) {
        if (!ts.isJsxAttribute(attr) || attr.name.getText(tree) !== 'style') continue;
        if (!/\/\/ Dynamic: .+/.test(attr.getFullText(tree))) errors.push('uncommented style');
        const init = attr.initializer;
        if (
          !init ||
          !ts.isJsxExpression(init) ||
          !init.expression ||
          !ts.isObjectLiteralExpression(init.expression)
        ) {
          errors.push('indirect style');
          continue;
        }
        for (const prop of init.expression.properties) {
          if (ts.isSpreadAssignment(prop) && prop.expression.getText(tree) === 'extraStyle')
            continue;
          if (!ts.isPropertyAssignment(prop) && !ts.isShorthandPropertyAssignment(prop)) {
            errors.push('non-dynamic style');
            continue;
          }
          const value = ts.isPropertyAssignment(prop) ? prop.initializer : prop.name;
          if (
            ts.isStringLiteral(value) ||
            ts.isNumericLiteral(value) ||
            ts.isConditionalExpression(value)
          ) {
            errors.push('static style');
          }
        }
      }
    }
    ts.forEachChild(node, visit);
  }
  visit(tree);
  return errors;
}

describe('SDK styling discipline', () => {
  const ui = fileURLToPath(new URL('.', import.meta.url));
  for (const file of readdirSync(ui).filter((f) => f.endsWith('.tsx') && !f.includes('.test.'))) {
    it(`${file} uses compiled utilities with only documented dynamic styles`, () => {
      expect(violations(readFileSync(`${ui}/${file}`, 'utf8'), file)).toEqual([]);
    });
  }

  it('rejects static, uncommented and indirect styles and runtime stylesheets', () => {
    expect(violations('<div style={{ color: "red" }} />')).toContain('uncommented style');
    expect(violations('<div // Dynamic: fake exemption\n style={{ color: "red" }} />')).toContain(
      'static style',
    );
    expect(violations('<div style={savedStyle} />')).toContain('indirect style');
    expect(violations('const NAVBAR_CSS = `body {}`')).toContain('CSS string');
    expect(violations('document.createElement("style")')).toContain('style injection');
    expect(violations('style.textContent = "body {}"')).toContain('CSS/HTML injection');
    expect(violations('<style>{"body {}"}</style>')).toContain('style element');
    expect(violations('<div // Dynamic: size from props\n style={{ width: size }} />')).toEqual([]);
  });
});
