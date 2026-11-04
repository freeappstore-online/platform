import { execFile, spawn } from 'node:child_process';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { expect, it } from 'vitest';

// pnpm --filter @freeappstore/sdk build
// FAS_TEST_HEADER=1 pnpm test packages/sdk/src/ui/header-reflow.integration.test.ts
it.skipIf(process.env.FAS_TEST_HEADER !== '1')(
  'reflows built SDK headers at 320px and 200% text (#374)',
  async () => {
    const dir = await mkdtemp(join(tmpdir(), 'fas-header-'));
    const cli = process.env.npm_execpath!;
    const run = promisify(execFile);
    const sdk = resolve('packages/sdk');
    const { version } = JSON.parse(await readFile(join(sdk, 'package.json'), 'utf8'));
    const options = { cwd: dir, timeout: 180_000, maxBuffer: 8 * 1024 * 1024 };
    // Pack the actual distribution: Tailwind must discover utilities in dist.
    await run(process.execPath, [cli, 'pack', '--pack-destination', dir], { ...options, cwd: sdk });
    await writeFile(
      join(dir, 'package.json'),
      JSON.stringify({
        type: 'module',
        dependencies: {
          '@freeappstore/sdk': `file:./freeappstore-sdk-${version}.tgz`,
          react: '^19.3.0',
          'react-dom': '^19.3.0',
          vite: '^8.3.4',
          tailwindcss: '^4.0.0',
          '@tailwindcss/vite': '^4.0.0',
        },
      }),
    );
    await writeFile(
      join(dir, 'vite.config.js'),
      `import {defineConfig} from 'vite'; import tailwind from '@tailwindcss/vite'; export default defineConfig({plugins:[tailwind()],esbuild:{jsx:'automatic'}});`,
    );
    await writeFile(
      join(dir, 'index.html'),
      '<meta name="viewport" content="width=device-width, initial-scale=1"><div id="root"></div><script type="module" src="/main.jsx"></script>',
    );
    await writeFile(
      join(dir, 'style.css'),
      '@import "tailwindcss"; @source "./node_modules/@freeappstore/sdk/dist";',
    );
    await writeFile(
      join(dir, 'main.jsx'),
      `
    import React from 'react'; import {createRoot} from 'react-dom/client';
    import {Shell} from '@freeappstore/sdk/ui'; import './style.css';
    const q = new URLSearchParams(location.search);
    const app = {auth:{user:q.has('user')?{id:'1',login:'LongUserName',avatarUrl:null}:null,init:async()=>{},onChange:()=>()=>{}},log:{_renderError:()=>{}}};
    createRoot(document.getElementById('root')).render(<Shell app={app} appName={q.has('long')?'VeryLongUnbrokenApplicationNameForMobileAccessibility':'Notes'}
      nav={[{label:'Home',href:'/'}]}
      renderNav={q.has('custom')?()=> <nav aria-label="Custom"><a href="/">Home</a></nav>:undefined}
      headerActions={q.has('custom')?<><button className="min-h-[44px] px-2">Create note</button><button className="min-h-[44px] px-2">Export</button></>:undefined}
    ><h1>Screen</h1></Shell>);
  `,
    );
    await run(process.execPath, [cli, 'install', '--no-frozen-lockfile'], options);
    await run(process.execPath, [cli, 'exec', 'vite', 'build'], options);
    const require = createRequire(new URL('../../../e2e/package.json', import.meta.url));
    const { chromium } = require('@playwright/test');
    const browser = await chromium.launch();
    const server = spawn(
      process.execPath,
      [
        join(dir, 'node_modules/vite/bin/vite.js'),
        'preview',
        '--host',
        '127.0.0.1',
        '--port',
        '5196',
        '--strictPort',
      ],
      { cwd: dir, stdio: 'pipe' },
    );
    try {
      for (let attempt = 0; ; attempt++) {
        try {
          if ((await fetch('http://127.0.0.1:5196')).ok) break;
        } catch {}
        if (attempt > 100) throw new Error('Preview failed');
        await new Promise((done) => setTimeout(done, 100));
      }
      const page = await browser.newPage({ viewport: { width: 320, height: 740 } });
      const errors: string[] = [];
      page.on('pageerror', (error: Error) => errors.push(error.message));
      for (const user of [false, true])
        for (const long of [false, true])
          for (const custom of [false, true]) {
            await page.goto(
              `http://127.0.0.1:5196/?${user ? 'user&' : ''}${long ? 'long&' : ''}${custom ? 'custom' : ''}`,
            );
            const profile = page.getByRole('link', { name: 'Profile', exact: true });
            await profile.waitFor();
            for (const size of [16, 32]) {
              await page.evaluate((size: number) => {
                document.documentElement.style.fontSize = size + 'px';
              }, size);
              expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(320);
              const title = page.locator('header > div > span').first();
              const titleBox = await title.boundingBox();
              expect(titleBox.width).toBeGreaterThan(100);
              expect(
                await title.evaluate((el: HTMLElement) => el.scrollWidth <= el.clientWidth),
              ).toBe(true);
              for (const control of await page.locator('header button, header a').all()) {
                const box = await control.boundingBox();
                if (!box) continue;
                expect(box.x).toBeGreaterThanOrEqual(0);
                expect(box.x + box.width).toBeLessThanOrEqual(320);
                if (await control.evaluate((el: Element) => el.tagName === 'BUTTON')) {
                  expect(box.width).toBeGreaterThanOrEqual(44);
                  expect(box.height).toBeGreaterThanOrEqual(44);
                }
                await control.focus();
                expect(await control.evaluate((el: Element) => el === document.activeElement)).toBe(
                  true,
                );
              }
              const avatar = await profile.boundingBox();
              expect(avatar.width).toBe(44);
              expect(avatar.height).toBe(44);
            }
          }
      expect(errors).toEqual([]);
      await page.close();
    } finally {
      server.kill();
      await browser.close();
    }
  },
  300_000,
);
