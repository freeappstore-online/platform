/// <reference types="vitest/config" />
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { VitePWA } from 'vite-plugin-pwa';
import { configDefaults } from 'vitest/config';

export default defineConfig({
  // Relative base so assets load correctly from any path prefix.
  // The console is served at freeappstore.online/app/ — the storefront Pages
  // Function functions/app/[[path]].ts strips the /app prefix and proxies to
  // the console origin (console.freeappstore.online). With the default base
  // '/', the HTML would ask for /assets/*, /manifest.webmanifest and
  // /registerSW.js at the apex root, bypassing that proxy and hitting the
  // storefront's 404. Relative './' emits ./assets/* etc., which resolve to
  // /app/assets/* under the proxy AND still work if the origin is hit directly.
  // Path-based (not a subdomain) keeps the OAuth session on one origin.
  // Mirrors the PAS console (pas/apps/console/web/vite.config.ts).
  base: './',
  plugins: [
    react(),
    tailwindcss(),
    VitePWA({
      registerType: 'autoUpdate',
      workbox: {
        // Brand URLs carry a kit version; use their current precached bytes offline.
        ignoreURLParametersMatching: [/^v$/, /^utm_/, /^fbclid$/],
        globPatterns: ['**/*.{js,css,html,png,svg,ico,woff2,wasm,json}'],
        // The Generate page's model worker and its runtime (#795) are downloaded only by creators who generate.
        globIgnores: ['assets/kokoro.worker-*', 'assets/ort-wasm-*'],
        maximumFileSizeToCacheInBytes: 10 * 1024 * 1024,
        runtimeCaching: [
          { urlPattern: /^https:\/\/fonts\.googleapis\.com\/.*/i, handler: 'CacheFirst',
            options: { cacheName: 'google-fonts-stylesheets',
              expiration: { maxEntries: 10, maxAgeSeconds: 60 * 60 * 24 * 365 },
              cacheableResponse: { statuses: [0, 200] } } },
          { urlPattern: /^https:\/\/fonts\.gstatic\.com\/.*/i, handler: 'CacheFirst',
            options: { cacheName: 'google-fonts-webfonts',
              expiration: { maxEntries: 30, maxAgeSeconds: 60 * 60 * 24 * 365 },
              cacheableResponse: { statuses: [0, 200] } } },
        ],
      },
      manifest: {
        name: "FreeAppStore Creator Console", short_name: "Console",
        description: "Creator Console for FreeAppStore",
        start_url: '/app/', scope: '/app/', display: 'standalone',
        background_color: "#ffffff", theme_color: "#2563eb",
        orientation: "any",
        icons: [
          { src: 'icon-192.png?v=2026-11-18', sizes: '192x192', type: 'image/png', purpose: 'any maskable' },
          { src: 'icon-512.png?v=2026-11-18', sizes: '512x512', type: 'image/png', purpose: 'any maskable' },
        ],
      },
    }),
  ],
  // The Generate page's worker loads the model's runtime with import(), so it can't be a classic script
  worker: { format: 'es' },
  server: { host: true },
  // e2e/*.spec.ts are Playwright specs (run by playwright.config.ts), not vitest
  // unit tests; vitest's default include glob would pick them up (#151).
  test: { exclude: [...configDefaults.exclude, 'e2e/**'] },
});
