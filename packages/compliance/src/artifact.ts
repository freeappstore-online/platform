import { matchAdNetworks } from './checks/no-ads.js';
import { matchPaymentsInContent } from './checks/no-payments.js';
import { matchTrackersInCode } from './checks/no-tracking.js';
import { stripCommentsForExt } from './lib/strip.js';
import type { CheckResult } from './types.js';

/**
 * Every FAS app must register a service worker (the PWA mandate `pwa-offline`
 * checks in source). True when one shipped file makes the call; the caller
 * requires it from at least one file of the artifact.
 */
export function registersServiceWorker(path: string, content: string): boolean {
  const ext = path.slice(path.lastIndexOf('.')).toLowerCase();
  return /\bserviceWorker\s*\.\s*register\s*\(/.test(stripCommentsForExt(content, ext));
}

/** Inspect the text actually shipped in a built app, without filesystem access. */
export function checkArtifactFiles(files: ReadonlyMap<string, string>): CheckResult[] {
  const ads: string[] = [];
  const trackers: string[] = [];
  const payments: string[] = [];
  for (const [path, content] of files) {
    const ext = path.slice(path.lastIndexOf('.')).toLowerCase();
    if (!['.html', '.htm', '.js', '.mjs', '.cjs', '.json', '.webmanifest'].includes(ext)) continue;
    const stripped = stripCommentsForExt(content, ext);
    const adMatches = matchAdNetworks(stripped);
    if (adMatches.length) ads.push(`${path} (${adMatches.join(', ')})`);
    const trackerMatches = matchTrackersInCode(stripped);
    if (trackerMatches.length) trackers.push(`${path} (${trackerMatches.join(', ')})`);
    const paymentMatches = matchPaymentsInContent(stripped);
    if (paymentMatches.length) payments.push(`${path} (${paymentMatches.join(', ')})`);
  }
  return [
    {
      name: 'No ads (built artifact)',
      status: ads.length ? 'fail' : 'pass',
      detail: ads.length ? ads.slice(0, 3).join('; ') : 'no ad network code in artifact',
    },
    {
      name: 'No direct tracking (built artifact)',
      status: trackers.length ? 'fail' : 'pass',
      detail: trackers.length ? trackers.slice(0, 3).join('; ') : 'no direct trackers in artifact',
    },
    {
      name: 'No payments (built artifact)',
      status: payments.length ? 'fail' : 'pass',
      detail: payments.length ? payments.slice(0, 3).join('; ') : 'no payment code in artifact',
    },
  ];
}
