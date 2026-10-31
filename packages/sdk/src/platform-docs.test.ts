import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';
import { getSdkReference } from '../../../workers/mcp/src/sdk-reference.js';
import { KV_LIMITS, PUSH_LIMITS } from '../../backend/src/lib/quota.js';

const root = fileURLToPath(new URL('../../../', import.meta.url));
const read = (path: string) => readFileSync(join(root, path), 'utf8');
const examples = [
  ['docs/sdk.md', read('docs/sdk.md')],
  ['packages/sdk/README.md', read('packages/sdk/README.md')],
  ['sites/storefront/SKILLS.md', read('sites/storefront/SKILLS.md')],
  ['sites/storefront/claude-code.md', read('sites/storefront/claude-code.md')],
  ['MCP sdk_reference', getSdkReference('all')],
];

/** Identify API expressions in examples without assuming the reader's app variables exist. */
function apiExpressions(code: string): string[] {
  const source = ts.createSourceFile(
    'example.tsx',
    code,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TSX,
  );
  const declarations: string[] = [];
  const aliases = new Set<string>();
  function factory(node: ts.Node) {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer) {
      const init = ts.isAwaitExpression(node.initializer)
        ? node.initializer.expression
        : node.initializer;
      if (ts.isCallExpression(init)) {
        const callee = init.expression.getText(source);
        if (callee === 'fas.collections.collection' || callee === 'fas.rooms.join') {
          aliases.add(node.name.text);
          declarations.push(`const ${node.name.text} = ${callee}('docs-example');`);
        }
      }
    }
    ts.forEachChild(node, factory);
  }
  factory(source);
  const expressions = new Set<string>();
  function visit(node: ts.Node) {
    if (ts.isPropertyAccessExpression(node)) {
      const expression = node.getText(source);
      if (/^fas\.\w+(?:\.\w+)?$/.test(expression)) expressions.add(expression);
      if ([...aliases].some((alias) => new RegExp(`^${alias}\\.\\w+$`).test(expression))) {
        expressions.add(expression);
      }
    }
    ts.forEachChild(node, visit);
  }
  visit(source);
  return [...declarations, ...[...expressions].map((value) => `void ${value};`)];
}

describe('public platform documentation matches the implementation', () => {
  it('the canonical limits table follows the enforced KV, push, email, and proxy caps', () => {
    const doc = read('docs/platform-limits.md');
    for (const row of [
      `| Max value size | ${KV_LIMITS.maxValueBytes / 1024}KB |`,
      `| Max bytes per user (per app) | ${KV_LIMITS.maxTotalBytesPerUser / (1024 * 1024)}MB |`,
      `| Max keys per user (per app) | ${KV_LIMITS.maxKeysPerUser} |`,
      `| Subscriptions (devices) per user per app | ${PUSH_LIMITS.maxSubscriptionsPerUser} |`,
      `| Endpoint URL length | ${PUSH_LIMITS.maxEndpointLength.toLocaleString('en-US')} chars |`,
    ])
      expect(doc).toContain(row);
    const constant = (path: string, name: string) => {
      const value = read(path).match(new RegExp(`const ${name} = ([\\d_]+);`))?.[1];
      expect(value, `${path}: ${name}`).toBeDefined();
      return Number(value!.replaceAll('_', ''));
    };
    const email = 'packages/backend/src/routes/email.ts';
    expect(doc).toContain(`| Emails per app per day | ${constant(email, 'DAILY_EMAIL_LIMIT')} |`);
    expect(doc).toContain(
      `| Emails per sending user per day | ${constant(email, 'DAILY_EMAIL_LIMIT_PER_USER')} |`,
    );
    const secrets = 'packages/backend/src/routes/secrets.ts';
    expect(doc).toContain(
      `| Proxy requests per day | ${constant(secrets, 'DAILY_PROXY_REQUESTS').toLocaleString('en-US')} |`,
    );
    expect(doc).toContain(
      `| User-key proxy requests | ${constant(secrets, 'DAILY_USER_KEY_REQUESTS').toLocaleString('en-US')}/day per user across all apps |`,
    );
  });

  it('publish flag tables match the actual CLI options', () => {
    const source = read('packages/cli/src/commands/publish.ts');
    const options = [...source.matchAll(/\.option\(\s*['"](?:-[a-z],\s*)?(--[a-z-]+)/g)].map(
      (m) => m[1],
    );
    expect(options).toContain('--store');
    for (const path of ['docs/cli.md', 'packages/cli/README.md']) {
      const text = read(path);
      const heading = /^#{2,3} `fas publish`[^\n]*\n/m.exec(text)!;
      const rest = text.slice(heading.index + heading[0].length);
      const next = rest.search(/^#{2,3} /m);
      const section = next < 0 ? rest : rest.slice(0, next);
      const flags = [...section.matchAll(/^\| `(--[a-z-]+)/gm)].map((m) => m[1]);
      expect(new Set(flags), path).toEqual(new Set(options));
    }
  });

  it('SDK and MCP examples reference real SDK, collection, and room members', () => {
    const checks: string[] = [];
    for (const [name, text] of examples) {
      let block = 0;
      for (const match of text.matchAll(/```(?:ts|tsx|typescript)\s*\n([\s\S]*?)```/g)) {
        const code = apiExpressions(match[1]);
        if (code.length) checks.push(`// ${name}, code block ${++block}\n{\n${code.join('\n')}\n}`);
      }
    }
    expect(checks.length).toBeGreaterThan(25);
    const file = join(root, 'packages/sdk/src/__documentation_contract.ts');
    const contents = `import type { FreeAppStore } from './index.js';\ndeclare const fas: FreeAppStore;\n${checks.join('\n')}`;
    const options: ts.CompilerOptions = {
      noEmit: true,
      strict: true,
      skipLibCheck: true,
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.ESNext,
      moduleResolution: ts.ModuleResolutionKind.Bundler,
      lib: ['lib.es2022.d.ts', 'lib.dom.d.ts', 'lib.dom.iterable.d.ts'],
      types: [],
    };
    const host = ts.createCompilerHost(options);
    const original = host.getSourceFile.bind(host);
    host.getSourceFile = (path, languageVersion, onError, shouldCreateNewSourceFile) =>
      path.replaceAll('\\', '/') === file.replaceAll('\\', '/')
        ? ts.createSourceFile(file, contents, languageVersion, true)
        : original(path, languageVersion, onError, shouldCreateNewSourceFile);
    const program = ts.createProgram([file], options, host);
    const errors = ts.getPreEmitDiagnostics(program).map((diagnostic) => {
      const line =
        diagnostic.file && diagnostic.start !== undefined
          ? diagnostic.file.getLineAndCharacterOfPosition(diagnostic.start).line + 1
          : 0;
      return `${diagnostic.file?.fileName}:${line}: ${ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n')}`;
    });
    expect(errors).toEqual([]);
  }, 30_000); // Compiles the SDK and DOM types; allow for contention in the full suite.

  it('documented webhook examples use an event the backend accepts', () => {
    const source = read('packages/backend/src/routes/webhooks.ts');
    const events = [
      ...source.match(/const SUPPORTED_EVENTS = \[([\s\S]*?)\];/)![1].matchAll(/'([^']+)'/g),
    ].map((m) => m[1]);
    for (const [name, text] of examples) {
      for (const match of text.matchAll(/\.webhooks\.create\(['"]([^'"]+)/g)) {
        expect(events, `${name}: ${match[1]}`).toContain(match[1]);
      }
    }
    expect(read('docs/platform-limits.md')).toContain(`| Event types | ${events.length} |`);
  });

  it('the published docs link only to pages included by their publication workflow', () => {
    const workflow = read('.github/workflows/publish-docs.yml');
    const published = new Set(
      [...workflow.matchAll(/^\s+- [^:]+: ([\w-]+\.md)$/gm)].map((m) => m[1]),
    );
    for (const page of published) {
      const text = read(`docs/${page}`).replace(/```[\s\S]*?```/g, '');
      for (const match of text.matchAll(/\]\(([^\s)]+\.md)(?:#[^)]*)?\)/g)) {
        if (/^[a-z]+:/.test(match[1])) continue;
        expect(published, `${page} links to unpublished ${match[1]}`).toContain(
          join(dirname(page), match[1]),
        );
      }
    }
  });
});
