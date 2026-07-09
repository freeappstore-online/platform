import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { VitePWA } from 'vite-plugin-pwa';

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
        globPatterns: ['**/*.{js,css,html,png,svg,ico,woff2,wasm,json}'],
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
        name: "FAS Creator Console", short_name: "Console",
        description: "Creator Console for FreeAppStore",
        start_url: '/app/', scope: '/app/', display: 'standalone',
        background_color: "#000000", theme_color: "#000000",
        orientation: "any",
        icons: [
          { src: 'icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any maskable' },
          { src: 'icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any maskable' },
        ],
      },
    }),
  ],
  server: { host: true },
});
