import { defineConfig } from 'vite';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));

// Alias @freeappstore/sdk to the source so edits to the SDK package hot-reload
// in this example without needing a separate `tsc --watch`.
export default defineConfig({
  resolve: {
    alias: {
      '@freeappstore/sdk': resolve(here, '../../packages/sdk/src/index.ts'),
    },
  },
  server: {
    port: 5173,
  },
});
