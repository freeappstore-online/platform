import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import ts from 'typescript';
import { afterEach, describe, expect, it } from 'vitest';
import { installCapabilities } from '../lib/capabilities.js';
import { getTemplateFiles, substituteAppName } from '../lib/starter-foundation.js';

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('fresh scaffold capability checks', () => {
  async function scaffold(sdkVersion: string) {
    const root = await mkdtemp(join(tmpdir(), 'fas-init-test-'));
    roots.push(root);
    await writeFile(join(root, 'package.json'), '{}');
    const web = join(root, 'web');
    await mkdir(web, { recursive: true });
    await writeFile(
      join(web, 'package.json'),
      JSON.stringify({
        dependencies: { '@freeappstore/sdk': sdkVersion },
        devDependencies: { 'vite-plugin-pwa': '^1.3.0' },
      }),
    );
    return root;
  }

  it('previews capability writes without touching files', async () => {
    const root = await scaffold('^0.16.39');
    const preview = await installCapabilities(root, ['pwa'], { dryRun: true });
    expect(preview.join('\n')).toContain('CREATE web/src/fas-capabilities/pwa.ts');
    await expect(readFile(join(root, '.fas-capabilities.json'))).rejects.toThrow();
  });

  it('uses SDK 0.16.39 as the fresh Shell baseline', () => {
    const files = getTemplateFiles(
      { store: 'apps', nounPlural: 'apps', r2Bucket: 'fas-apps' },
      'generic',
      'standalone',
    );
    expect(JSON.parse(files['web/package.json']!).dependencies['@freeappstore/sdk']).toBe(
      '^0.16.39',
    );
    expect(files['CLAUDE.md']).toContain('/docs/starter-release.md');
  });

  it('requires the SDK API used by the current PWA recipe', async () => {
    const root = await scaffold('^0.16.19');
    const preview = await installCapabilities(root, ['pwa'], { dryRun: true });
    expect(preview.join('\n')).toContain('@freeappstore/sdk >=0.16.39');
    expect(preview.join('\n')).toContain('INCOMPLETE');
    await expect(installCapabilities(root, ['pwa'])).rejects.toThrow('>=0.16.39');
  });

  it('rejects an edited capability file as a conflict', async () => {
    const root = await scaffold('^0.16.39');
    await installCapabilities(root, ['pwa']);
    await writeFile(join(root, 'web/src/fas-capabilities/pwa.ts'), '// app edit');
    await expect(installCapabilities(root, ['pwa'], { dryRun: true })).rejects.toThrow('conflict');
  });
});

it.each(['standalone', 'connected'] as const)('declares a real favicon asset for %s', (preset) => {
  const files = getTemplateFiles(
    { store: 'apps', nounPlural: 'apps', r2Bucket: 'fas-apps' },
    'generic',
    preset,
  );
  const href = /<link[^>]*rel="icon"[^>]*type="image\/svg\+xml"[^>]*href="([^"]+)"/.exec(
    files['web/index.html']!,
  )?.[1];
  expect(href).toBeTruthy();
  expect(files[`web/public${href}`]).toMatch(/<svg\s/);
});

describe('starter display name substitution', () => {
  it.each([
    'Notes [Beta',
    'Notes "Draft"',
    'Budget $&',
    'Budget $$',
    'APPNAME APPID',
    '100% $value {draft} \\ café 📝',
  ])('keeps %s as display text without changing the app ID or generated syntax', (displayName) => {
    const generated = substituteAppName(
      getTemplateFiles(
        { store: 'apps', nounPlural: 'apps', r2Bucket: 'fas-apps' },
        'generic',
        'connected',
      ),
      'review-notes',
      displayName,
    );

    expect(JSON.parse(generated['package.json']!).name).toBe('review-notes');
    expect(JSON.parse(generated['web/package.json']!).name).toBe('@review-notes/web');
    expect(JSON.parse(generated['web/public/manifest.json']!).name).toBe(displayName);
    expect(generated['web/index.html']).toContain(
      `content="${displayName.replaceAll('&', '&amp;').replaceAll('"', '&quot;')} — FreeAppStore"`,
    );

    const app = generated['web/src/App.tsx']!;
    const result = ts.transpileModule(app, {
      compilerOptions: { jsx: ts.JsxEmit.ReactJSX, target: ts.ScriptTarget.ES2022 },
      reportDiagnostics: true,
    });
    expect(
      (result.diagnostics ?? []).map(({ code, start, messageText }) => ({
        code,
        start,
        messageText,
      })),
    ).toEqual([]);
    const source = ts.createSourceFile(
      'App.tsx',
      app,
      ts.ScriptTarget.Latest,
      true,
      ts.ScriptKind.TSX,
    );
    const embeddedStrings: string[] = [];
    const collectStrings = (node: ts.Node) => {
      if (ts.isStringLiteral(node)) embeddedStrings.push(node.text);
      ts.forEachChild(node, collectStrings);
    };
    collectStrings(source);
    expect(embeddedStrings).toContain(displayName);
    expect(embeddedStrings).toContain(`Welcome to ${displayName}`);
    expect(app).toContain('appId: "review-notes"');
    expect(app).not.toContain('APPNAME_JS');
    expect(app).not.toContain('APPNAME_TEXT');
    if (!displayName.includes('APPID')) expect(app).not.toContain('APPID');
    if (!displayName.includes('APPNAME')) expect(app).not.toContain('APPNAME');
  });
});
