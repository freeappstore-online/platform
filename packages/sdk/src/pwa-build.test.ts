import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runInNewContext } from 'node:vm';
import { expect, it, vi } from 'vitest';
import { pwaOptions } from './pwa-config.js';

it('generates a real precached worker with offline deep-link fallback and guarded activation', async () => {
  // Resolve the same Workbox compiler used by the declared Vite PWA dependency.
  const require = createRequire(import.meta.url);
  const pluginRequire = createRequire(require.resolve('vite-plugin-pwa'));
  const { generateSW } = pluginRequire('workbox-build');
  const root = await mkdtemp(join(tmpdir(), 'fas-pwa-build-'));
  try {
    await writeFile(join(root, 'index.html'), '<main>Offline shell</main>');
    await writeFile(join(root, 'app.js'), 'console.log("app")');
    await writeFile(join(root, 'icon.svg'), '<svg xmlns="http://www.w3.org/2000/svg"/>');
    const config = pwaOptions({ workbox: { navigateFallbackDenylist: [/^\/oauth/] } });
    const result = await generateSW({
      ...config.workbox,
      globDirectory: root,
      swDest: join(root, 'sw.js'),
      mode: 'development',
    });
    expect(result.count).toBe(3);
    expect(result.warnings).toEqual([]);
    const worker = await readFile(join(root, 'sw.js'), 'utf8');
    expect(worker).toContain('index.html');
    expect(worker).toContain('icon.svg');
    expect(worker).toContain('NavigationRoute');
    expect(worker).toContain('createHandlerBoundToURL("/index.html")');
    expect(worker).toContain('SKIP_WAITING');
    const listeners: Record<string, (event: { data: unknown }) => void> = {};
    const skipWaiting = vi.fn();
    const self = {
      define: true,
      skipWaiting,
      addEventListener: (name: string, listener: (event: { data: unknown }) => void) => {
        listeners[name] = listener;
      },
    };
    runInNewContext(worker, {
      self,
      define: (_deps: string[], factory: (workbox: unknown) => void) =>
        factory({
          clientsClaim: vi.fn(),
          precacheAndRoute: vi.fn(),
          registerRoute: vi.fn(),
          createHandlerBoundToURL: vi.fn(),
          NavigationRoute: class {},
        }),
    });
    expect(skipWaiting).not.toHaveBeenCalled();
    listeners.message!({ data: { type: 'OTHER' } });
    expect(skipWaiting).not.toHaveBeenCalled();
    listeners.message!({ data: { type: 'SKIP_WAITING' } });
    expect(skipWaiting).toHaveBeenCalledOnce();
    expect(worker).toContain('clientsClaim');
    expect(worker).toContain('oauth');
    expect(worker).toContain('api');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}, 30_000);
