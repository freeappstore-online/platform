import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import ts from 'typescript';

/** Only used inside a newly cloned, disposable scaffold, never on an existing app. */
export async function configureFreshPwa(root: string) {
  const configPath = join(root, 'web/vite.config.ts');
  const config = await readFile(configPath, 'utf8');
  const source = ts.createSourceFile(configPath, config, ts.ScriptTarget.Latest, true);
  const calls: ts.CallExpression[] = [];
  function visit(node: ts.Node) {
    if (
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === 'VitePWA'
    )
      calls.push(node);
    ts.forEachChild(node, visit);
  }
  visit(source);
  const call = calls[0];
  if (calls.length !== 1 || !call || call.arguments.length !== 1)
    throw new Error('Fresh template must contain one VitePWA(options) call.');
  const argument = call.arguments[0]!;
  // Print the AST without the obsolete copied comments; retain every app option.
  const options = ts
    .createPrinter({ removeComments: true })
    .printNode(ts.EmitHint.Expression, argument, source);
  const next = `${config.slice(0, argument.getStart(source))}pwaOptions(${options})${config.slice(argument.end)}`;
  await writeFile(configPath, `import { pwaOptions } from './fas-pwa-config';\n${next}`);
  const mainPath = join(root, 'web/src/main.tsx');
  await writeFile(
    mainPath,
    `import './fas-capabilities/pwa';\n${await readFile(mainPath, 'utf8')}`,
  );
  const packagePath = join(root, 'web/package.json');
  const pkg = JSON.parse(await readFile(packagePath, 'utf8'));
  pkg.dependencies['@freeappstore/sdk'] = '^0.16.15';
  await writeFile(packagePath, `${JSON.stringify(pkg, null, 2)}\n`);
  const htmlPath = join(root, 'web/index.html');
  const html = await readFile(htmlPath, 'utf8');
  await writeFile(
    htmlPath,
    html.replace(/,?\s*(?:user-scalable\s*=\s*(?:no|0)|maximum-scale\s*=\s*[\d.]+)/gi, ''),
  );
}
