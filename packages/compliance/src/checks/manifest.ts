import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { CheckResult } from '../types.js';

/**
 * Verifies the PWA manifest exists at the expected location and parses
 * to JSON. Apps without a manifest can't be "Add to Home Screen"-d on
 * mobile; required by the platform.
 */
export async function checkManifest(repoDir: string): Promise<CheckResult> {
  const path = join(repoDir, 'web', 'public', 'manifest.json');
  let raw: string;
  try {
    raw = await readFile(path, 'utf8');
  } catch {
    return {
      name: 'PWA manifest',
      status: 'fail',
      detail: 'web/public/manifest.json missing',
      suggestions: [
        'Add a manifest.json with at least name, short_name, start_url, display, icons.',
        'See template-standalone for a working example.',
      ],
    };
  }

  let parsed: { name?: unknown; short_name?: unknown; start_url?: unknown; display?: unknown };
  try {
    parsed = JSON.parse(raw);
  } catch {
    return {
      name: 'PWA manifest',
      status: 'fail',
      detail: `web/public/manifest.json is not valid JSON`,
    };
  }

  const required = ['name', 'short_name', 'start_url', 'display'] as const;
  const missing = required.filter((k) => typeof parsed[k] !== 'string' || parsed[k] === '');
  if (missing.length > 0) {
    return {
      name: 'PWA manifest',
      status: 'warn',
      detail: `missing fields: ${missing.join(', ')}`,
      suggestions: [`Add the ${missing.join(', ')} field(s) to manifest.json so installs work.`],
    };
  }
  return { name: 'PWA manifest', status: 'pass', detail: 'web/public/manifest.json' };
}
