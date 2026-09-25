import type { FileSource } from '../lib/file-source.js';
import type { CheckResult } from '../types.js';

/**
 * Verifies the canonical CSS custom properties are *defined* in the
 * project's theme CSS. This is the inverse of `no-brand-overrides`:
 * one ensures the tokens haven't been redefined elsewhere, the other
 * ensures they exist in the first place.
 *
 * Apps and games alike must define `--paper`, `--ink`, `--accent`. Games
 * used to require `--bg` instead, but DESIGN-SYSTEM.md bans `--bg` as an
 * alias of `--paper` in every store, so no game could satisfy both (#64).
 * A game's canvas is still dark — only the token name is shared.
 *
 * We scan all CSS / SCSS files (not just the canonical theme path) so
 * the check passes whether the creator's tokens live in `index.css`,
 * `main.css`, or some other theme file.
 */
export async function checkBrandTokens(source: FileSource): Promise<CheckResult> {
  const required = ['--paper', '--ink', '--accent'];
  const found = new Set<string>();

  for await (const path of source.list()) {
    if (!path.endsWith('.css') && !path.endsWith('.scss')) continue;
    const content = await source.read(path);
    if (!content) continue;
    for (const token of required) {
      // Match `--token:` as a CSS declaration (not `var(--token)`).
      const re = new RegExp(`(?:^|[\\s;{,])${token}\\s*:`, 'm');
      if (re.test(content)) found.add(token);
    }
    if (found.size === required.length) break;
  }

  const missing = required.filter((t) => !found.has(t));
  if (missing.length === 0) {
    return { name: 'Brand tokens defined', status: 'pass', detail: required.join(' + ') };
  }
  return {
    name: 'Brand tokens defined',
    status: 'fail',
    detail: `missing CSS tokens: ${missing.join(', ')}`,
    suggestions: [
      `Define ${missing.join(', ')} in your theme CSS (typically web/src/index.css).`,
      `Apps and games both use --paper / --ink / --accent (--bg is a banned alias of --paper).`,
    ],
  };
}
