import type { FileSource } from '../lib/file-source.js';
import type { CheckResult } from '../types.js';

/**
 * Apps must allow text selection. Setting `user-select: none` on body
 * or html blocks copy/paste of all content — a common PWA anti-pattern
 * that hurts accessibility and usability.
 *
 * Acceptable: `user-select: none` scoped to buttons, nav, labels, or
 * elements with role="button". Only body/html-level blanket disabling fails.
 */
export async function checkTextSelectable(source: FileSource): Promise<CheckResult> {
  const issues: string[] = [];

  for await (const path of source.list()) {
    if (!path.endsWith('.css') && !path.endsWith('.scss')) continue;
    const content = await source.read(path);
    if (!content) continue;

    for (const re of BODY_USER_SELECT_NONE) {
      const m = re.exec(content);
      if (m) {
        const line = lineNumberAt(content, m.index);
        issues.push(`${path}:${line} — user-select: none on body/html blocks all text selection. Scope it to buttons/nav instead.`);
      }
    }

    if (issues.length >= 5) break;
  }

  if (issues.length > 0) {
    return {
      name: 'Text selectable',
      status: 'warn',
      detail: `${issues.length} blanket user-select: none found`,
      suggestions: [
        ...issues,
        'Remove `user-select: none` from body/html. Add it only to buttons, nav, labels, [role="button"].',
      ],
    };
  }

  return {
    name: 'Text selectable',
    status: 'pass',
    detail: 'no blanket text-selection blocking detected',
  };
}

// Match user-select: none on html or body selectors
const BODY_USER_SELECT_NONE = [
  /(?:^|[\s,{])(?:html|body)\s*\{[^}]*user-select\s*:\s*none/im,
  /(?:^|[\s,{])(?:html|body)\s*\{[^}]*-webkit-user-select\s*:\s*none/im,
];

function lineNumberAt(content: string, index: number): number {
  let n = 1;
  for (let i = 0; i < index; i++) if (content.charCodeAt(i) === 10) n++;
  return n;
}
