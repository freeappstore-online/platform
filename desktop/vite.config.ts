import { fileURLToPath } from 'node:url';
import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

const page = (name: string) => fileURLToPath(new URL(`src/renderer/${name}`, import.meta.url));

// The home window's UI and the hidden Contribute window (#826), loaded from disk by the main process.
export default defineConfig({
  root: 'src/renderer',
  base: './',
  plugins: [react(), tailwindcss()],
  build: {
    outDir: '../../dist/renderer',
    emptyOutDir: true,
    rollupOptions: { input: [page('index.html'), page('contribute.html')] },
  },
});
