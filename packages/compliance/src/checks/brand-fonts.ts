import { readFile } from 'node:fs/promises';
import { extname } from 'node:path';
import type { CheckResult } from '../types.js';
import { walk } from '../lib/walk.js';

const REQUIRED_FONTS = ['Manrope', 'Fraunces'];

/**
 * The platform's brand wants Manrope (body) + Fraunces (display) so apps
 * have a consistent typographic feel across the storefront. We accept any
 * CSS file referencing both font names — the actual font-loading mechanism
 * (Google Fonts, self-hosted, etc.) is the app's choice.
 */
export async function checkBrandFonts(repoDir: string): Promise<CheckResult> {
  const found = new Set<string>();
  for await (const file of walk(repoDir)) {
    const ext = extname(file).toLowerCase();
    if (ext !== '.css' && ext !== '.scss' && ext !== '.html') continue;
    const content = await readFile(file, 'utf8').catch(() => '');
    for (const font of REQUIRED_FONTS) {
      if (content.includes(font)) found.add(font);
    }
    if (found.size === REQUIRED_FONTS.length) break;
  }

  const missing = REQUIRED_FONTS.filter((f) => !found.has(f));
  if (missing.length === 0) {
    return {
      name: 'Brand fonts present',
      status: 'pass',
      detail: REQUIRED_FONTS.join(' + '),
    };
  }
  return {
    name: 'Brand fonts present',
    status: 'fail',
    detail: `missing: ${missing.join(', ')}`,
    suggestions: [
      'Add the Google Fonts <link> for Manrope + Fraunces to web/index.html.',
      'Use them as your body / display fonts in CSS so storefront and apps feel consistent.',
    ],
  };
}
