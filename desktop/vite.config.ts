import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

// The home window's UI, loaded from disk by the main process.
export default defineConfig({
  root: 'src/renderer',
  base: './',
  plugins: [react(), tailwindcss()],
  build: { outDir: '../../dist/renderer', emptyOutDir: true },
});
