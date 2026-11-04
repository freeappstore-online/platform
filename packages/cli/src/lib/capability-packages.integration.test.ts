import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { expect, it } from 'vitest';
import { installCapabilities } from './capabilities.js';

// Explicit network-backed release check: FAS_TEST_PUBLISHED=1 pnpm test <this file>.
it.skipIf(process.env.FAS_TEST_PUBLISHED !== '1')(
  'builds generated persistence, backup, and PWA imports with published packages',
  async () => {
    const root = await mkdtemp(join(tmpdir(), 'fas-published-capabilities-'));
    const run = promisify(execFile);
    try {
      await mkdir(join(root, 'web/src'), { recursive: true });
      await writeFile(
        join(root, 'package.json'),
        JSON.stringify({
          private: true,
          type: 'module',
          dependencies: { '@freeappstore/sdk': '0.16.21' },
          devDependencies: { vite: '8.3.4', 'vite-plugin-pwa': '1.3.0', typescript: '5.9.3' },
        }),
      );
      // No web package: generated imports resolve the root's published dependencies.
      await installCapabilities(root, ['persistence', 'backup', 'pwa']);
      await writeFile(
        join(root, 'web/index.html'),
        '<html><body><script type="module" src="/src/main.ts"></script></body></html>',
      );
      await writeFile(
        join(root, 'web/src/main.ts'),
        `import './fas-capabilities/pwa';
import { getPreference, putFile } from '../../fas-capabilities/persistence';
import { exportBackup } from '../../fas-capabilities/backup';
console.log(getPreference, putFile, exportBackup);
`,
      );
      await writeFile(
        join(root, 'web/vite.config.ts'),
        `import { defineConfig } from 'vite';
import { VitePWA } from 'vite-plugin-pwa';
import { pwaOptions } from './fas-pwa-config';
export default defineConfig({ plugins: [VitePWA(pwaOptions({ manifest: { name: 'Fixture', short_name: 'Fixture', start_url: '/', display: 'standalone' } }))] });
`,
      );
      const cli = process.env.npm_execpath;
      if (!cli) throw new Error('Run this integration check through pnpm test.');
      const options = { cwd: root, timeout: 120_000, maxBuffer: 4 * 1024 * 1024 };
      await run(process.execPath, [cli, 'install', '--ignore-scripts'], options);
      await run(
        process.execPath,
        [
          join(root, 'node_modules/typescript/bin/tsc'),
          '--noEmit',
          '--skipLibCheck',
          '--module',
          'nodenext',
          '--target',
          'es2022',
          'fas-capabilities/persistence.ts',
          'fas-capabilities/backup.ts',
          'web/src/fas-capabilities/pwa.ts',
          'web/fas-pwa-config.ts',
        ],
        options,
      );
      const result = await run(
        process.execPath,
        [join(root, 'node_modules/vite/bin/vite.js'), 'build', 'web'],
        options,
      );
      expect(result.stdout).toContain('built in');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
  240_000,
);
