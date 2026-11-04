import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { installCapabilities } from './capabilities.js';
import { configureFreshPwa } from './pwa-scaffold.js';

it('wires a fresh template, retains custom caching/denylist, enables zoom and records metadata', async () => {
  const root = await mkdtemp(join(tmpdir(), 'pwa-scaffold-'));
  try {
    await mkdir(join(root, 'web/src'), { recursive: true });
    await writeFile(join(root, 'package.json'), '{}');
    await writeFile(
      join(root, 'web/package.json'),
      JSON.stringify({
        dependencies: { '@freeappstore/sdk': '^0.16.19' },
        devDependencies: { 'vite-plugin-pwa': '^1.3.0' },
      }),
    );
    await writeFile(
      join(root, 'web/vite.config.ts'),
      `const config = VitePWA({ registerType: 'autoUpdate', workbox: {
      // Stale claims must not survive fresh scaffolding.
      skipWaiting: true, navigateFallbackDenylist: [/^\\/custom/], runtimeCaching: [{urlPattern: /^\\/public-fonts/, handler: 'CacheFirst'}]
    } });`,
    );
    await writeFile(join(root, 'web/src/main.tsx'), 'renderApp();');
    await writeFile(
      join(root, 'web/index.html'),
      '<meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1, user-scalable=no">',
    );
    await installCapabilities(root, ['pwa']);
    const packageBefore = await readFile(join(root, 'web/package.json'), 'utf8');
    await configureFreshPwa(root);
    expect(await readFile(join(root, 'web/package.json'), 'utf8')).toBe(packageBefore);
    const config = await readFile(join(root, 'web/vite.config.ts'), 'utf8');
    expect(config).toContain('pwaOptions(');
    expect(config).toContain('public-fonts');
    expect(config).toContain('custom');
    expect(config).not.toContain('Stale claims');
    expect(await readFile(join(root, 'web/src/main.tsx'), 'utf8')).toContain(
      "import './fas-capabilities/pwa'",
    );
    expect(await readFile(join(root, 'web/index.html'), 'utf8')).not.toMatch(
      /maximum-scale|user-scalable/,
    );
    const manifest = JSON.parse(await readFile(join(root, '.fas-capabilities.json'), 'utf8'));
    expect(manifest.capabilities.pwa.metadata.offline).toBe('shell-only');
    expect(await installCapabilities(root, ['pwa'])).toEqual(['No changes.']);
    await writeFile(join(root, 'web/src/fas-capabilities/pwa.ts'), 'my guards');
    await expect(installCapabilities(root, ['pwa'])).rejects.toThrow('conflict');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
