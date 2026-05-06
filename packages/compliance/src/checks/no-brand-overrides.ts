import { readFile } from 'node:fs/promises';
import { extname, relative } from 'node:path';
import type { CheckResult } from '../types.js';
import { walk } from '../lib/walk.js';

/**
 * Apps and games on the platform must look consistent with the storefront
 * and with each other — brand colors, fonts, and layout rhythm come from
 * the template, not the app. This check fails on the most common forms of
 * brand-override drift:
 *
 *   1. Custom CSS variable overrides for the platform-defined tokens
 *      (--paper, --ink, --accent, --line, --panel, --muted). These are
 *      defined by the template; an app redefining them changes the brand.
 *   2. Custom font-family declarations beyond the brand stack
 *      (Manrope, Fraunces) and the system / monospace fallbacks.
 *
 * What's allowed:
 *   - Using the variables (color: var(--accent)) — that's the whole point.
 *   - Hardcoded colors for non-brand purposes (highlight states, error
 *     red, etc.). We don't try to gate every hex literal — too noisy and
 *     too many false positives.
 */
export async function checkNoBrandOverrides(repoDir: string): Promise<CheckResult> {
  const issues: string[] = [];

  for await (const file of walk(repoDir)) {
    const ext = extname(file).toLowerCase();
    if (!SCANNED_EXTS.has(ext)) continue;
    const content = await readFile(file, 'utf8').catch(() => '');
    if (!content) continue;
    const rel = relative(repoDir, file);
    // Canonical theme file: the platform's CSS variables ARE defined here.
    // Apps own this file post-scaffold (they can technically modify token
    // values, and we accept the imperfection — the loud places where a
    // brand override actually causes inconsistency are inline styles +
    // per-component CSS, which this check still covers).
    const isThemeFile = rel === 'web/src/index.css' || rel === 'web/src/main.css';
    const fileIssues = scanContent(rel, content, { skipVarRedefs: isThemeFile });
    issues.push(...fileIssues);
    // Cap at 10 — beyond that the user has bigger problems and we don't
    // want a 200-line failure report.
    if (issues.length >= 10) break;
  }

  if (issues.length === 0) {
    return {
      name: 'No brand overrides',
      status: 'pass',
      detail: 'apps inherit colors + fonts from the template',
    };
  }
  return {
    name: 'No brand overrides',
    status: 'fail',
    detail: `${issues.length} apparent override${issues.length === 1 ? '' : 's'}`,
    suggestions: [
      ...issues.slice(0, 5),
      ...(issues.length > 5 ? [`...and ${issues.length - 5} more`] : []),
      'Use the template tokens (var(--accent), var(--ink), etc.) instead of redefining them.',
      'Brand fonts are Manrope (body) + Fraunces (display). Stick to those + system / monospace.',
    ],
  };
}

const SCANNED_EXTS = new Set(['.css', '.scss', '.tsx', '.ts', '.jsx', '.js', '.html']);

const PROTECTED_VARS = new Set([
  '--paper',
  '--ink',
  '--muted',
  '--accent',
  '--line',
  '--line-strong',
  '--panel',
]);

/**
 * Whitelist of font-family declarations we accept. Anything outside this
 * set — for ANY font name not in the brand stack and not a generic /
 * system fallback — flags. The check is case-insensitive.
 */
const ALLOWED_FONT_TOKENS = new Set([
  // Brand stack
  'manrope',
  'fraunces',
  // Generic/system fallbacks (CSS keywords)
  'serif',
  'sans-serif',
  'monospace',
  'system-ui',
  'ui-monospace',
  'ui-serif',
  'ui-sans-serif',
  'inherit',
  'initial',
  'unset',
  'revert',
  // Common system stack names — these are aliases, not custom fonts.
  '-apple-system',
  'blinkmacsystemfont',
  'segoe ui',
  'roboto',
  'helvetica',
  'helvetica neue',
  'arial',
  'sf mono',
  'sf pro',
  'menlo',
  'monaco',
  'consolas',
  'liberation mono',
  'courier',
  'courier new',
  'georgia',
  'noto sans',
  'noto color emoji',
  'apple color emoji',
  'segoe ui emoji',
  'segoe ui symbol',
]);

export function scanContent(
  filename: string,
  content: string,
  opts: { skipVarRedefs?: boolean } = {},
): string[] {
  const out: string[] = [];

  // 1. CSS variable overrides for protected tokens.
  // Match `--accent: <something>;` outside of var() invocations.
  // The regex looks for "<two dashes><name>:" near the start of a line,
  // which is how CSS declarations look. var(--accent) won't match because
  // there's a `(` not a `:`.
  if (!opts.skipVarRedefs) {
    const varDeclRe = /(?:^|[\s;{,])(--[a-z-]+)\s*:/gim;
    let m: RegExpExecArray | null;
    while ((m = varDeclRe.exec(content)) !== null) {
      const name = m[1]!;
      if (PROTECTED_VARS.has(name)) {
        const line = lineNumberAt(content, m.index);
        out.push(`${filename}:${line} redefines ${name} (template owns this token)`);
      }
    }
  }

  // 2. font-family overrides. Pull every string after `font-family:` (in
  // CSS) or `fontFamily:` (in JSX/TS), parse the comma-separated list,
  // and flag any quoted token not in ALLOWED_FONT_TOKENS.
  const fontRe = /(?:font-family|fontFamily)\s*[:=]\s*["'`]?([^;"'`}\n]+)["'`]?/g;
  let m: RegExpExecArray | null;
  while ((m = fontRe.exec(content)) !== null) {
    const list = m[1]!;
    const tokens = list
      .split(',')
      .map((t) => t.trim().replace(/^["']|["']$/g, '').toLowerCase())
      .filter(Boolean);
    for (const t of tokens) {
      if (!ALLOWED_FONT_TOKENS.has(t)) {
        const line = lineNumberAt(content, m.index);
        out.push(`${filename}:${line} non-brand font "${t}"`);
        break; // one warning per declaration is plenty
      }
    }
  }

  return out;
}

function lineNumberAt(content: string, index: number): number {
  let n = 1;
  for (let i = 0; i < index; i++) if (content.charCodeAt(i) === 10) n++;
  return n;
}
