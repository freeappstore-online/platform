import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import ts from 'typescript';
import { describe, expect, it, vi } from 'vitest';
import { registry } from '../packages/cli/src/lib/capability-definitions.js';
import { getSdkReference } from '../workers/mcp/src/sdk-reference.js';

const codeBlock = (text: string) => /```ts\n([\s\S]*?)```/.exec(text)?.[1] ?? '';

function diagnostics(code: string) {
  const dir = mkdtempSync(join(tmpdir(), 'fas-sdk-example-'));
  const file = join(dir, 'example.ts');
  writeFileSync(file, code);
  try {
    const program = ts.createProgram([file], {
      strict: true,
      noEmit: true,
      skipLibCheck: true,
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.ESNext,
      moduleResolution: ts.ModuleResolutionKind.Bundler,
      types: [],
      baseUrl: process.cwd(),
      paths: {
        '@freeappstore/sdk/persist': [resolve('packages/sdk/src/persist/index.ts')],
        '@freeappstore/sdk/backup': [resolve('packages/sdk/src/backup/index.ts')],
      },
    });
    return ts
      .getPreEmitDiagnostics(program)
      .map((diagnostic) => ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n'));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe('examples handed to app authors', () => {
  it.each(['persistence', 'backup'])(
    'typechecks the actual %s MCP and capability recipe',
    (feature) => {
      const code = codeBlock(getSdkReference(feature));
      expect(code.length).toBeGreaterThan(100);
      expect(codeBlock(registry[feature]!.files[`fas-capabilities/${feature}.md`]!)).toBe(code);
      expect(diagnostics(code)).toEqual([]);
    },
    20_000,
  );

  it('detects the exact invalid openStore call that broke Pitstop', () => {
    const code = codeBlock(getSdkReference('persistence')).replace(
      "openStore({ namespace: 'notes', version: 1 })",
      "openStore('notes')",
    );
    expect(diagnostics(code).join('\n')).toMatch(/string.*OpenStoreOptions/);
  }, 20_000);

  it('the published Shell example routes a query/hash destination by pathname', () => {
    const statement = getSdkReference('shell')
      .split('\n')
      .find((line) => line.trim().startsWith('const navigate ='))!;
    const location = { pathname: '/' };
    const setPath = vi.fn();
    const history = {
      pushState: (_state: unknown, _title: string, href: string) => {
        location.pathname = new URL(href, 'https://example.test').pathname;
      },
    };
    new Function(
      'history',
      'location',
      'setPath',
      `${
        ts.transpileModule(statement, { compilerOptions: { target: ts.ScriptTarget.ES2022 } })
          .outputText
      }; navigate("/tags?sort=new#saved")`,
    )(history, location, setPath);
    expect(setPath).toHaveBeenCalledWith('/tags');
  });
});
