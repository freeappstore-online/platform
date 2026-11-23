import { describe, expect, it } from 'vitest';
import { mapFileSource } from '../lib/file-source.js';
import { checkSdkUiStyles } from './sdk-ui-styles.js';

const APP = `import { FasShell } from '@freeappstore/sdk/ui'\nexport default () => <FasShell />`;
const run = (files: Record<string, string>) =>
  checkSdkUiStyles(mapFileSource(new Map(Object.entries(files))));

describe('checkSdkUiStyles (#648)', () => {
  it('fails when sdk/ui is imported but no stylesheet @sources the SDK', async () => {
    const result = await run({
      'web/src/App.tsx': APP,
      'web/src/index.css': '@import "tailwindcss";',
    });
    expect(result.status).toBe('fail');
    expect(result.detail).toContain('web/src/App.tsx');
    expect(result.suggestions?.[0]).toContain('@source "../node_modules/@freeappstore/sdk/dist";');
  });

  it('passes with the template @source lines', async () => {
    const result = await run({
      'web/src/App.tsx': APP,
      'web/src/index.css':
        '@import "tailwindcss";\n@source "../node_modules/@freeappstore/sdk/dist";\n@source "../../node_modules/@freeappstore/sdk/dist";',
    });
    expect(result.status).toBe('pass');
  });

  it('fails for SDK 0.16+ and passes for older SDKs, which inject their own styles', async () => {
    const files = (range: string) => ({
      'web/package.json': JSON.stringify({ dependencies: { '@freeappstore/sdk': range } }),
      'web/src/App.tsx': APP,
      'web/src/index.css': '@import "tailwindcss";',
    });
    expect((await run(files('^0.16.48'))).status).toBe('fail');
    expect((await run(files('0.17.1'))).status).toBe('fail');
    expect((await run(files('^0.14.20'))).status).toBe('pass');
  });

  it('passes when the app does not use the SDK UI', async () => {
    const result = await run({
      'web/src/App.tsx': `import { initApp } from '@freeappstore/sdk'`,
      'web/src/index.css': '@import "tailwindcss";',
    });
    expect(result.status).toBe('pass');
  });
});
