import type { FileSource } from '../lib/file-source.js';
import type { CheckResult } from '../types.js';

/**
 * Build artefacts and dependency trees must not be committed.
 *
 * A hygiene sweep found 46 published FAS apps with `node_modules/` in git —
 * roughly 3,000 tracked files each, ~138k files in total. The templates all
 * gitignore it correctly, so this is drift introduced after scaffolding, and
 * nothing blocked it at publish time.
 *
 * Why this check reads `listTracked()` rather than `list()`: the question is
 * whether a path is *tracked by git*, not whether it exists on disk. Those are
 * different questions with different answers. `node_modules/` existing locally
 * is normal — you just ran an install — so a presence check would fail every
 * healthy repo. And `list()` filters those directories out entirely, so it
 * could never see them regardless.
 *
 * Degrades to `warn` (never `fail`) when there is no VCS view, matching how
 * bundle-size handles a missing `listDir`. The agent's Map-backed source has
 * no git, and a false fail there would block legitimate publishes.
 */

/** Directory prefixes that must never be tracked. */
const FORBIDDEN_DIRS = ['node_modules', 'dist', '.next', '.cache', '.turbo', '.wrangler'];

/** Exact basenames that must never be tracked. */
const FORBIDDEN_FILES = ['.DS_Store', 'Thumbs.db'];

/** How many offending paths to name before summarising the rest. */
const SAMPLE_LIMIT = 5;

export async function checkNoCommittedArtifacts(source: FileSource): Promise<CheckResult> {
  const name = 'No committed build artifacts';

  if (!source.listTracked) {
    return {
      name,
      status: 'warn',
      detail: 'file source has no version-control view — cannot check tracked paths',
    };
  }

  const tracked = await source.listTracked();
  if (tracked === null) {
    return {
      name,
      status: 'warn',
      detail: 'not a git repository (or git unavailable) — skipping tracked-artifact check',
    };
  }

  // Group offenders by the rule they broke so the message stays readable
  // even when a single node_modules contributes thousands of paths.
  const byRule = new Map<string, string[]>();
  for (const path of tracked) {
    const segments = path.split('/');
    const dirHit = FORBIDDEN_DIRS.find((d) => segments.includes(d));
    if (dirHit) {
      const list = byRule.get(`${dirHit}/`) ?? [];
      list.push(path);
      byRule.set(`${dirHit}/`, list);
      continue;
    }
    const base = segments[segments.length - 1] ?? '';
    if (FORBIDDEN_FILES.includes(base)) {
      const list = byRule.get(base) ?? [];
      list.push(path);
      byRule.set(base, list);
    }
  }

  if (byRule.size === 0) {
    return {
      name,
      status: 'pass',
      detail: 'no build artifacts or dependency trees tracked in git',
    };
  }

  const total = [...byRule.values()].reduce((n, paths) => n + paths.length, 0);
  const summary = [...byRule.entries()]
    .sort((a, b) => b[1].length - a[1].length)
    .map(([rule, paths]) => {
      const sample = paths.slice(0, SAMPLE_LIMIT).join(', ');
      const more = paths.length > SAMPLE_LIMIT ? `, +${paths.length - SAMPLE_LIMIT} more` : '';
      return `${rule} (${paths.length} file${paths.length === 1 ? '' : 's'}: ${sample}${more})`;
    })
    .join('; ');

  return {
    name,
    status: 'fail',
    detail: `${total} tracked artifact file(s) — ${summary}`,
    suggestions: [
      'Untrack them without deleting your local copies: `git rm -r --cached node_modules dist`',
      'Add `node_modules/`, `dist/` and `.DS_Store` to .gitignore, then commit.',
      'Verify nothing artefact-shaped remains: `git ls-files | grep -E "node_modules/|dist/|\\.DS_Store"`',
    ],
  };
}
