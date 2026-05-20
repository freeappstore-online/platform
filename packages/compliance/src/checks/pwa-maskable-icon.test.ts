import { describe, expect, it } from 'vitest';
import { mapFileSource } from '../lib/file-source.js';
import { checkMaskableIcon } from './pwa-maskable-icon.js';

const PASSING_VITE = `
import { VitePWA } from "vite-plugin-pwa";
export default {
  plugins: [
    VitePWA({
      manifest: {
        name: 'X', short_name: 'X', start_url: '/', display: 'standalone',
        icons: [
          { src: '/icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any maskable' },
          { src: '/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any maskable' },
        ],
      },
    }),
  ],
};
`;

const SEPARATE_ENTRY_VITE = `
import { VitePWA } from "vite-plugin-pwa";
export default {
  plugins: [
    VitePWA({
      manifest: {
        name: 'X', short_name: 'X', start_url: '/', display: 'standalone',
        icons: [
          { src: '/icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
          { src: '/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
        ],
      },
    }),
  ],
};
`;

const NO_PURPOSE_VITE = `
import { VitePWA } from "vite-plugin-pwa";
export default {
  plugins: [
    VitePWA({
      manifest: {
        name: 'X', short_name: 'X', start_url: '/', display: 'standalone',
        icons: [
          { src: '/icon-192.png', sizes: '192x192', type: 'image/png' },
          { src: '/icon-512.png', sizes: '512x512', type: 'image/png' },
        ],
      },
    }),
  ],
};
`;

describe('checkMaskableIcon', () => {
  it("passes when icons use combined 'any maskable'", async () => {
    const src = mapFileSource(new Map([['web/vite.config.ts', PASSING_VITE]]));
    const r = await checkMaskableIcon(src);
    expect(r.status).toBe('pass');
  });

  it("passes when a separate entry has purpose 'maskable'", async () => {
    const src = mapFileSource(new Map([['web/vite.config.ts', SEPARATE_ENTRY_VITE]]));
    const r = await checkMaskableIcon(src);
    expect(r.status).toBe('pass');
  });

  it('fails when no icon declares purpose containing "maskable"', async () => {
    const src = mapFileSource(new Map([['web/vite.config.ts', NO_PURPOSE_VITE]]));
    const r = await checkMaskableIcon(src);
    expect(r.status).toBe('fail');
    expect(r.detail).toMatch(/maskable/);
  });

  it('passes for a static manifest.json with maskable icon', async () => {
    const manifest = JSON.stringify({
      name: 'X',
      short_name: 'X',
      start_url: '/',
      display: 'standalone',
      icons: [
        { src: '/icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any maskable' },
      ],
    });
    const src = mapFileSource(new Map([['web/public/manifest.json', manifest]]));
    const r = await checkMaskableIcon(src);
    expect(r.status).toBe('pass');
  });

  it('fails for a static manifest.json missing maskable', async () => {
    const manifest = JSON.stringify({
      name: 'X',
      icons: [{ src: '/icon-192.png', sizes: '192x192', type: 'image/png' }],
    });
    const src = mapFileSource(new Map([['web/public/manifest.json', manifest]]));
    const r = await checkMaskableIcon(src);
    expect(r.status).toBe('fail');
  });

  it('passes silently when no manifest source at all (covered by manifest check)', async () => {
    const src = mapFileSource(new Map());
    const r = await checkMaskableIcon(src);
    expect(r.status).toBe('pass');
  });
});
