import { readdir, readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
import type { CheckResult } from '../types.js';

const MAX_GZIP_BYTES = 300 * 1024; // 300 KB — matches the template's compliance.yml

/**
 * Checks the largest JS asset under web/dist/assets/ against the 300KB-gzip
 * limit. Returns 'warn' if dist hasn't been built yet (we don't want to
 * silently pass when there's nothing to measure).
 */
export async function checkBundleSize(repoDir: string): Promise<CheckResult> {
  const assetsDir = join(repoDir, 'web', 'dist', 'assets');
  let entries;
  try {
    entries = await readdir(assetsDir);
  } catch {
    return {
      name: 'Bundle size',
      status: 'warn',
      detail: 'web/dist not built yet — run `pnpm build` to measure',
    };
  }

  const jsFiles = entries.filter((f) => f.endsWith('.js'));
  if (jsFiles.length === 0) {
    return {
      name: 'Bundle size',
      status: 'warn',
      detail: `no JS files in ${assetsDir}`,
    };
  }

  // Find the largest JS file (the entry chunk) — same behavior as the
  // existing compliance.yml in the templates.
  let largest = '';
  let largestSize = 0;
  for (const f of jsFiles) {
    const s = await stat(join(assetsDir, f));
    if (s.size > largestSize) {
      largest = f;
      largestSize = s.size;
    }
  }

  const content = await readFile(join(assetsDir, largest));
  const gzipped = gzipSync(content).byteLength;
  const kb = (gzipped / 1024).toFixed(1);
  const limitKb = (MAX_GZIP_BYTES / 1024).toFixed(0);

  if (gzipped > MAX_GZIP_BYTES) {
    return {
      name: 'Bundle size',
      status: 'fail',
      detail: `${largest}: ${kb} KB gzipped (limit ${limitKb} KB)`,
      suggestions: [
        'Find heavy dependencies: `pnpm dlx vite-bundle-visualizer`',
        'Lazy-load non-critical screens with dynamic import().',
        'Consider lighter alternatives for the biggest deps.',
      ],
    };
  }

  return {
    name: 'Bundle size',
    status: 'pass',
    detail: `${largest}: ${kb} KB gzipped (limit ${limitKb} KB)`,
  };
}
