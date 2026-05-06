import { readFile } from 'node:fs/promises';
import { extname } from 'node:path';
import type { CheckResult } from '../types.js';
import { walk } from '../lib/walk.js';

// Same forbidden list the template's compliance.yml enforces — kept in
// sync because both are downstream consumers of this package long-term.
const FORBIDDEN = [
  'google-analytics',
  'gtag',
  'amplitude',
  'mixpanel',
  'segment',
  'hotjar',
  'plausible',
  'posthog',
];

const SCAN_EXTS = new Set(['.ts', '.tsx', '.js', '.jsx', '.html', '.json']);

export async function checkNoTracking(repoDir: string): Promise<CheckResult> {
  const hits: { file: string; matches: string[] }[] = [];

  for await (const file of walk(repoDir)) {
    if (!SCAN_EXTS.has(extname(file).toLowerCase())) continue;
    const content = await readFile(file, 'utf8').catch(() => '');
    const matches = FORBIDDEN.filter((sdk) => content.includes(sdk));
    if (matches.length > 0) {
      hits.push({ file: file.replace(repoDir + '/', ''), matches });
    }
  }

  if (hits.length === 0) {
    return {
      name: 'No tracking SDKs',
      status: 'pass',
      detail: `scanned for ${FORBIDDEN.length} known trackers`,
    };
  }

  return {
    name: 'No tracking SDKs',
    status: 'fail',
    detail: `${hits.length} file(s) reference trackers: ${hits
      .slice(0, 3)
      .map((h) => `${h.file} (${h.matches.join(', ')})`)
      .join('; ')}${hits.length > 3 ? '…' : ''}`,
    suggestions: [
      'FreeAppStore apps must be tracking-free. Remove the SDK + any analytics calls.',
      'For private-by-design metrics, CF edge analytics already counts requests anonymously.',
    ],
  };
}
