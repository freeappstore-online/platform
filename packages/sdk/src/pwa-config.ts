import type { VitePWAOptions } from 'vite-plugin-pwa';

/** Shared vite-plugin-pwa options. App manifest/icons remain app-owned. */
export function pwaOptions(overrides: Partial<VitePWAOptions> = {}): Partial<VitePWAOptions> {
  if (overrides.strategies && overrides.strategies !== 'generateSW')
    throw new Error('pwaOptions requires generateSW; review custom worker lifecycle separately.');
  return {
    manifest: false as const,
    ...overrides,
    // Runtime registration belongs to startPwa; never inject another reloader.
    registerType: 'prompt' as const,
    injectRegister: false as const,
    workbox: {
      globPatterns: ['**/*.{js,css,html,png,svg,ico,woff2}'],
      navigateFallback: '/index.html',
      ...overrides.workbox,
      navigateFallbackDenylist: [
        /^\/api(?:\/|$)/,
        /^\/v1(?:\/|$)/,
        ...(overrides.workbox?.navigateFallbackDenylist ?? []),
      ],
      skipWaiting: false,
      clientsClaim: true,
    },
  };
}
