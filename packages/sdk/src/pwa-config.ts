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
      maximumFileSizeToCacheInBytes: 10 * 1024 * 1024,
      runtimeCaching: [
        {
          urlPattern: /^https:\/\/fonts\.googleapis\.com\//i,
          handler: 'CacheFirst',
          options: {
            cacheName: 'fas-font-styles-v1',
            cacheableResponse: { statuses: [0, 200] },
            expiration: { maxEntries: 20, maxAgeSeconds: 7 * 24 * 60 * 60 },
          },
        },
        {
          urlPattern: /^https:\/\/fonts\.gstatic\.com\//i,
          handler: 'CacheFirst',
          options: {
            cacheName: 'fas-font-files-v1',
            cacheableResponse: { statuses: [0, 200] },
            expiration: { maxEntries: 30, maxAgeSeconds: 365 * 24 * 60 * 60 },
          },
        },
      ],
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
