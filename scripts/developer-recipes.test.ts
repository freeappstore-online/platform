import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import ts from 'typescript';
import { describe, expect, it, vi } from 'vitest';
import { registry } from '../packages/cli/src/lib/capability-definitions.js';
import { FORM_EXAMPLE } from '../packages/cli/src/lib/developer-recipes.js';
import { getTemplateFiles } from '../packages/cli/src/lib/starter-foundation.js';
import { getSdkReference } from '../workers/mcp/src/sdk-reference.js';

const codeBlock = (text: string) => /```ts\n([\s\S]*?)```/.exec(text)?.[1] ?? '';

function publishedPaths(): Record<string, string[]> {
  const app = process.env.FAS_EXAMPLE_APP;
  if (!app) return {};
  const sdk = resolve(app, 'web/node_modules/@freeappstore/sdk');
  const exports = JSON.parse(readFileSync(join(sdk, 'package.json'), 'utf8')).exports as Record<
    string,
    { types?: string } | string
  >;
  const paths: Record<string, string[]> = {};
  for (const [key, value] of Object.entries(exports)) {
    if (typeof value === 'object' && value.types)
      paths[`@freeappstore/sdk${key === '.' ? '' : key.slice(1)}`] = [resolve(sdk, value.types)];
  }
  paths.react = [resolve(app, 'web/node_modules/@types/react/index.d.ts')];
  paths['react/jsx-runtime'] = [resolve(app, 'web/node_modules/@types/react/jsx-runtime.d.ts')];
  return paths;
}

function diagnostics(code: string, jsx = false, extra: Record<string, string> = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'fas-sdk-example-'));
  const file = join(dir, jsx ? 'web/src/components/example.tsx' : 'example.ts');
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, code);
  for (const [path, body] of Object.entries(extra)) {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), body);
  }
  try {
    const program = ts.createProgram([file], {
      strict: true,
      noEmit: true,
      skipLibCheck: true,
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.ESNext,
      moduleResolution: ts.ModuleResolutionKind.Bundler,
      types: [],
      jsx: ts.JsxEmit.ReactJSX,
      baseUrl: process.cwd(),
      paths: process.env.FAS_EXAMPLE_APP
        ? publishedPaths()
        : {
            '@freeappstore/sdk': [resolve('packages/sdk/src/index.ts')],
            '@freeappstore/sdk/hooks': [resolve('packages/sdk/src/hooks.ts')],
            '@freeappstore/sdk/pwa': [resolve('packages/sdk/src/pwa.ts')],
            '@freeappstore/sdk/pwa-config': [resolve('packages/sdk/src/pwa-config.ts')],
            '@freeappstore/sdk/media': [resolve('packages/sdk/src/media.ts')],
            react: [resolve('packages/sdk/node_modules/@types/react/index.d.ts')],
            'react/jsx-runtime': [
              resolve('packages/sdk/node_modules/@types/react/jsx-runtime.d.ts'),
            ],
            '@freeappstore/sdk/ui': [resolve('packages/sdk/src/ui/index.ts')],
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
  it('does not fall back to unpublished source when a released subpath is missing', () => {
    const app = mkdtempSync(join(tmpdir(), 'fas-example-missing-export-'));
    const sdk = join(app, 'web/node_modules/@freeappstore/sdk');
    mkdirSync(sdk, { recursive: true });
    writeFileSync(
      join(sdk, 'package.json'),
      JSON.stringify({ exports: { '.': { types: './index.d.ts' } } }),
    );
    writeFileSync(join(sdk, 'index.d.ts'), 'export {};');
    vi.stubEnv('FAS_EXAMPLE_APP', app);
    try {
      expect(
        diagnostics("import { openStore } from '@freeappstore/sdk/persist';").join('\n'),
      ).toContain("Cannot find module '@freeappstore/sdk/persist'");
    } finally {
      vi.unstubAllEnvs();
      rmSync(app, { recursive: true, force: true });
    }
  });
  it('actual room recipe stops delivering events after abort and closes once', () => {
    const subscribers = new Map<string, Set<(value: unknown) => void>>();
    const subscribe = (kind: string) => (listener: (value: unknown) => void) => {
      const listeners = subscribers.get(kind) ?? new Set();
      subscribers.set(kind, listeners);
      listeners.add(listener);
      return () => listeners.delete(listener);
    };
    const room = {
      onConnectionState: subscribe('state'),
      onPeers: subscribe('peers'),
      onMessage: subscribe('message'),
      close: vi.fn(),
    };
    const handlers = { onState: vi.fn(), onPeers: vi.fn(), onMessage: vi.fn() };
    const source = registry.realtime!.files['fas-capabilities/realtime.ts']!;
    const code = ts.transpileModule(source, {
      compilerOptions: { module: ts.ModuleKind.CommonJS },
    }).outputText;
    const watchRoom = new Function('exports', `${code}; return exports.watchRoom;`)({});
    const abort = new AbortController();
    const watched = watchRoom({ rooms: { join: () => room } }, 'example', handlers, abort.signal);
    const emit = () => {
      for (const cb of subscribers.get('state') ?? []) cb('open');
      for (const cb of subscribers.get('peers') ?? []) cb([{}, {}]);
      for (const cb of subscribers.get('message') ?? []) cb({ data: 'hello' });
    };
    emit();
    expect(handlers.onPeers).toHaveBeenCalledWith(2);
    abort.abort();
    watched.close();
    emit();
    for (const handler of Object.values(handlers)) expect(handler).toHaveBeenCalledOnce();
    expect(room.close).toHaveBeenCalledOnce();
  });
  it('typechecks the whole Shell example, including every referenced screen', () => {
    const code = /```tsx\n([\s\S]*?)```/.exec(getSdkReference('shell'))?.[1] ?? '';
    expect(diagnostics(code, true)).toEqual([]);
  }, 20_000);

  it('delivers and typechecks the real connected component and its controller import', () => {
    const files = getTemplateFiles(
      { store: 'apps', r2Bucket: 'fas-apps', nounPlural: 'apps' },
      'generic',
      'connected',
    );
    const code = /```tsx\n([\s\S]*?)```/.exec(getSdkReference('connected-data'))?.[1] ?? '';
    expect(code).toBe(files['web/src/components/ConnectedDraft.tsx']);
    expect(
      diagnostics(code, true, {
        'web/src/fas-capabilities/pwa.ts': files['web/src/fas-capabilities/pwa.ts']!,
      }),
    ).toEqual([]);
  }, 20_000);

  it.each(['pwa', 'realtime', 'media'])(
    'typechecks the actual optional %s module',
    (id) => {
      const module = Object.entries(registry[id]!.files).find(([path]) => path.endsWith('.ts'))![1];
      expect(diagnostics(module)).toEqual([]);
    },
    20_000,
  );

  it.each(['kv', 'counters', 'collections', 'rooms'])(
    'typechecks %s API fragments in their declared app context',
    (feature) => {
      const fragment = /```tsx\n([\s\S]*?)```/.exec(getSdkReference(feature))?.[1] ?? '';
      expect(
        diagnostics(
          `import { initApp } from '@freeappstore/sdk';\nconst fas = initApp({ appId: 'example' });\n${fragment}`,
          true,
        ),
      ).toEqual([]);
    },
    20_000,
  );

  it.each([
    [undefined, false, false],
    [{ state: 'inactive' }, false, false],
    [{ state: 'paused' }, false, true],
    [{ state: 'recording' }, false, true],
    [undefined, true, true],
  ])('media guide guard handles recorder=%j and unsaved=%s', (recorder, unsaved, expected) => {
    const callback = registry
      .media!.files['fas-capabilities/media.md']!.split('\n')
      .find((line) => line.includes('() =>') && line.includes('hasUnsavedMedia'))!
      .trim()
      .replace(/,$/, '');
    expect(
      new Function('recorder', 'hasUnsavedMedia', `return (${callback})();`)(recorder, unsaved),
    ).toBe(expected);
  });
  it('typechecks the actual form delivered in MCP and developer docs', () => {
    const code = /```tsx\n([\s\S]*?)```/.exec(getSdkReference('forms'))?.[1];
    expect(code).toBe(FORM_EXAMPLE);
    const guide = readFileSync('docs/ui.md', 'utf8').split('## Editable forms')[1]!;
    expect(/```tsx\n([\s\S]*?)```/.exec(guide)?.[1]).toBe(FORM_EXAMPLE);
    expect(diagnostics(FORM_EXAMPLE, true)).toEqual([]);
  }, 20_000);
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
