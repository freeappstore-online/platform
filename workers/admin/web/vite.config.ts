import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { VitePWA } from 'vite-plugin-pwa';

export default defineConfig({
  plugins: [
    react(),
    tailwindcss(),
    VitePWA({
      registerType: 'autoUpdate',
      includeAssets: ['favicon.svg', 'icon.svg', 'apple-touch-icon.png'],
      workbox: {
        // Brand URLs carry a kit version; use their current precached bytes offline.
        ignoreURLParametersMatching: [/^v$/, /^utm_/, /^fbclid$/],
        globPatterns: ['**/*.{js,css,html,png,svg,ico,woff2,json}'],
        // Admin data is dynamic + FAS-session-gated — never let the SW
        // serve a cached shell for /api or intercept API calls.
        navigateFallbackDenylist: [/^\/api\//],
      },
      manifest: {
        name: 'FreeAppStore Admin',
        short_name: 'FAS Admin',
        description: 'FreeAppStore platform admin — apps, AI grants, provisioning, sessions.',
        start_url: '/',
        scope: '/',
        display: 'standalone',
        background_color: '#0b0d12',
        theme_color: '#2563eb',
        orientation: 'any',
        icons: [
          { src: 'icon-192.png?v=2026-11-18', sizes: '192x192', type: 'image/png', purpose: 'any maskable' },
          { src: 'icon-512.png?v=2026-11-18', sizes: '512x512', type: 'image/png', purpose: 'any maskable' },
        ],
      },
    }),
  ],
  build: {
    outDir: '../public',
    emptyOutDir: true,
  },
  server: {
    proxy: {
      '/api': 'http://localhost:8787',
    },
  },
});
