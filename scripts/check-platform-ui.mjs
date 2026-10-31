import { readdir, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import ts from 'typescript';
import {
  checkCssDiscipline,
  checkNoExcessiveInlineStyles,
  checkOpaqueSurface,
  mapFileSource,
} from '../packages/compliance/dist/index.js';

export const UI_ROOTS = ['packages/sdk/src/ui', 'sites/console/web/src', 'workers/admin/web/src'];

/** Parse TSX so comments and example strings cannot inflate the counts. */
export function scanRuntimeStyles(text, path) {
  const source = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true);
  let inline = 0;
  let uncommented = 0;
  let injection = 0;
  const css = (value) => /(?:[.#:@\w-]+\s*\{[^}]*:|@(?:import|layer|media))/.test(value);
  const visit = (node) => {
    if (
      ts.isJsxAttribute(node) &&
      node.name.getText(source) === 'style' &&
      node.initializer &&
      ts.isJsxExpression(node.initializer) &&
      node.initializer.expression &&
      ts.isObjectLiteralExpression(node.initializer.expression)
    ) {
      inline++;
      // FAS requires a reason beside genuinely dynamic styles. Only nearby
      // comments mentioning the dynamic value qualify, not arbitrary comments.
      const before = text.slice(0, node.getStart(source)).split('\n').slice(-3).join('\n');
      if (
        !/(?:\/\/|\/\*)[^\n]*(?:dynamic|computed|position|transform|progress|width|height)/i.test(
          before,
        )
      )
        uncommented++;
    }
    if (
      ts.isVariableDeclaration(node) &&
      /(?:^|_)CSS$/.test(node.name.getText(source)) &&
      node.initializer &&
      (ts.isNoSubstitutionTemplateLiteral(node.initializer) ||
        ts.isTemplateExpression(node.initializer))
    )
      injection++;
    if (
      ts.isBinaryExpression(node) &&
      node.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
      ts.isPropertyAccessExpression(node.left) &&
      node.left.name.text === 'textContent'
    ) {
      const rhs = node.right.getText(source);
      if (
        css(rhs) ||
        /(?:^|\b)\w*CSS\b/.test(rhs) ||
        /(?:style|sheet)/i.test(node.left.expression.getText(source))
      )
        injection++;
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return { inline, uncommented, injection };
}

async function* walk(dir) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = `${dir}/${entry.name}`;
    if (entry.isDirectory()) yield* walk(path);
    else if (/\.(?:css|[jt]sx?)$/.test(path) && !/\.(?:test|spec)\./.test(path)) yield path;
  }
}

export async function lintPlatformUi({ strict = false } = {}) {
  let violations = 0;
  for (const dir of UI_ROOTS) {
    const files = new Map();
    for await (const path of walk(dir)) {
      const text = await readFile(path, 'utf8');
      files.set(`web/src/${path.slice(dir.length + 1)}`, text);
      if (path.endsWith('.css')) continue;
      const counts = scanRuntimeStyles(text, path);
      if (counts.inline || counts.injection) {
        console.log(
          `${strict ? 'CHECK' : 'WARN'} ${path}: ${counts.inline} inline styles, ${counts.uncommented} without a dynamic reason, ${counts.injection} runtime CSS injections`,
        );
      }
      violations += counts.uncommented + counts.injection;
    }
    const source = mapFileSource(files);
    for (const check of [checkCssDiscipline, checkNoExcessiveInlineStyles, checkOpaqueSurface]) {
      const result = await check(source);
      console.log(`${result.status.toUpperCase()} ${dir}: ${result.name}: ${result.detail}`);
    }
  }
  console.log(
    `Platform UI: ${violations} runtime CSS / uncommented inline findings (${strict ? 'strict' : 'warn-only migration mode; #322 pending'}).`,
  );
  return strict && violations ? 1 : 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  process.exitCode = await lintPlatformUi({ strict: process.argv.includes('--strict') });
}
