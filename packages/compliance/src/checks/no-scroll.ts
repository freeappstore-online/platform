import { readFile } from 'node:fs/promises';
import { extname, relative } from 'node:path';
import type { CheckResult } from '../types.js';
import { walk } from '../lib/walk.js';

/**
 * Games on FreeGameStore must fit the viewport — no horizontal or
 * vertical scroll at the document level. Static analysis catches the
 * common CSS / inline-style anti-patterns:
 *
 *   - `overflow: scroll` or `overflow: auto` on `html` or `body`.
 *   - `min-height: 100vh` on `html` / `body` (creates page that's at
 *     least viewport-tall, but content + topbar = > 100vh = scroll).
 *   - Missing the `100svh` / `100vh` height constraint on the layout
 *     wrapper (loose check — "at least one root element should hard-cap
 *     to viewport height").
 *
 * Runtime guarantees (real DOM measurement) live in the e2e Playwright
 * suite; this check exists as a fast pre-publish gate so creators
 * don't ship trivially-scrolling games.
 *
 * Apps (FreeAppStore) are not subject to this check — the apps Shell
 * wraps them in a sidebar+main layout that legitimately scrolls. We
 * detect "is this a game project" by looking for the @freeappstore/games
 * dep, the canonical signal that the app uses GameShell.
 */
export async function checkNoScroll(repoDir: string): Promise<CheckResult> {
  // Skip apps — only games are subject to no-scroll.
  if (!(await isGame(repoDir))) {
    return {
      name: 'No scroll (games only)',
      status: 'pass',
      detail: 'not a game project — check skipped',
    };
  }

  const issues: string[] = [];
  let sawViewportLock = false;

  for await (const file of walk(repoDir)) {
    const ext = extname(file).toLowerCase();
    if (!SCAN_EXTS.has(ext)) continue;
    const content = await readFile(file, 'utf8').catch(() => '');
    if (!content) continue;
    const rel = relative(repoDir, file);

    // 1. Forbidden overflow declarations on root elements.
    for (const re of FORBIDDEN_OVERFLOW) {
      const m = re.exec(content);
      if (m) {
        const line = lineNumberAt(content, m.index);
        issues.push(`${rel}:${line} ${m[0]} — root scrolling not allowed in games`);
      }
    }

    // 2. min-height on root elements (creates pages taller than viewport).
    for (const re of FORBIDDEN_MIN_HEIGHT) {
      const m = re.exec(content);
      if (m) {
        const line = lineNumberAt(content, m.index);
        issues.push(`${rel}:${line} ${m[0]} — use exact viewport height (100svh) instead`);
      }
    }

    // 3. Look for at least one viewport-lock pattern. GameShell sets
    // `height: 100svh` on a fixed wrapper; we accept any 100svh / 100vh
    // declaration as evidence the game considered viewport sizing.
    if (VIEWPORT_LOCK.test(content)) sawViewportLock = true;

    if (issues.length >= 8) break;
  }

  if (issues.length > 0) {
    return {
      name: 'No scroll (games only)',
      status: 'fail',
      detail: `${issues.length} scroll-enabling pattern${issues.length === 1 ? '' : 's'}`,
      suggestions: [
        ...issues.slice(0, 5),
        ...(issues.length > 5 ? [`...and ${issues.length - 5} more`] : []),
        'Use <GameShell> from @freeappstore/games — it locks layout to 100svh.',
        'Inside the play area, use overflow: hidden instead of overflow: auto.',
      ],
    };
  }

  if (!sawViewportLock) {
    return {
      name: 'No scroll (games only)',
      status: 'warn',
      detail: 'no 100svh/100vh viewport lock detected — game may scroll on small viewports',
      suggestions: [
        'Wrap your game in <GameShell> from @freeappstore/games, or',
        'Add `height: 100svh` to your root container.',
      ],
    };
  }

  return {
    name: 'No scroll (games only)',
    status: 'pass',
    detail: 'viewport-locked layout detected',
  };
}

const SCAN_EXTS = new Set(['.css', '.scss', '.tsx', '.ts', '.jsx', '.js', '.html']);

// Match `overflow: scroll` and `overflow: auto` on html/body selectors,
// or as bare global rules in CSS. Conservative: only flags when paired
// with html/body — avoids false positives for component-scoped overflow.
//
// IMPORTANT: no `g` flag. Module-scoped regexes with `g` share lastIndex
// across parallel test runs and produce flaky matches; we only need
// first-match-per-file anyway.
const FORBIDDEN_OVERFLOW = [
  /(?:^|[\s,{])(?:html|body)\s*\{[^}]*overflow\s*:\s*(?:scroll|auto)/im,
  /(?:^|[\s,{])(?:html|body)\s*\{[^}]*overflow-(?:x|y)\s*:\s*(?:scroll|auto)/im,
];

const FORBIDDEN_MIN_HEIGHT = [
  /(?:^|[\s,{])(?:html|body)\s*\{[^}]*min-height\s*:\s*100vh/im,
];

const VIEWPORT_LOCK = /(?:height|max-height)\s*:\s*100(?:s?vh)|GameShell|@freeappstore\/games/i;

async function isGame(repoDir: string): Promise<boolean> {
  // Fast path: look for the explicit games-sdk dep in any package.json.
  // Falls back to scanning JSX for GameShell import — catches cases
  // where the dep is hoisted to a workspace root.
  for await (const file of walk(repoDir)) {
    const base = file.split('/').pop() ?? '';
    if (base !== 'package.json') continue;
    const content = await readFile(file, 'utf8').catch(() => '');
    if (/@freeappstore\/games/.test(content)) return true;
  }
  for await (const file of walk(repoDir)) {
    const ext = extname(file).toLowerCase();
    if (ext !== '.tsx' && ext !== '.ts') continue;
    const content = await readFile(file, 'utf8').catch(() => '');
    if (/from\s+['"]@freeappstore\/games['"]/.test(content)) return true;
  }
  return false;
}

function lineNumberAt(content: string, index: number): number {
  let n = 1;
  for (let i = 0; i < index; i++) if (content.charCodeAt(i) === 10) n++;
  return n;
}
