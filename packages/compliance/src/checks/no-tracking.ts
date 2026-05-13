import type { FileSource } from '../lib/file-source.js';
import type { CheckResult } from '../types.js';

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

export async function checkNoTracking(source: FileSource): Promise<CheckResult> {
  const hits: { file: string; matches: string[] }[] = [];

  for await (const path of source.list()) {
    if (!SCAN_EXTS.has(extOf(path))) continue;
    const content = await source.read(path);
    if (!content) continue;
    const matches = FORBIDDEN.filter((sdk) => content.includes(sdk));
    if (matches.length > 0) {
      hits.push({ file: path, matches });
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

function extOf(path: string): string {
  const dot = path.lastIndexOf('.');
  const slash = path.lastIndexOf('/');
  return dot > slash ? path.slice(dot).toLowerCase() : '';
}
