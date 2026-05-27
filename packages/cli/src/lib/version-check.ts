/**
 * Non-blocking minimum-version check.
 *
 * On every CLI invocation we fire-and-forget a check against the npm registry
 * to see if a newer @freeappstore/cli exists. The result is cached in
 * ~/.fas/version-check.json for 24 hours so we don't spam the registry.
 *
 * If the current version is older than the latest, a yellow warning is printed
 * to stderr (so it never pollutes piped stdout). Failures (offline, rate-limited,
 * DNS errors) are silently swallowed.
 */

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { yellow } from './style.js';

const CACHE_DIR = join(homedir(), '.fas');
const CACHE_FILE = join(CACHE_DIR, 'version-check.json');
const REGISTRY_URL = 'https://registry.npmjs.org/@freeappstore/cli/latest';

/** How long a cached result stays valid (24 hours). */
const TTL_MS = 24 * 60 * 60 * 1000;

interface CachedCheck {
  latestVersion: string;
  checkedAt: number; // epoch ms
}

/**
 * Compare two semver strings. Returns:
 *   -1 if a < b, 0 if equal, 1 if a > b.
 * Only handles x.y.z (no pre-release tags).
 */
function compareSemver(a: string, b: string): -1 | 0 | 1 {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  for (let i = 0; i < 3; i++) {
    const va = pa[i] ?? 0;
    const vb = pb[i] ?? 0;
    if (va < vb) return -1;
    if (va > vb) return 1;
  }
  return 0;
}

/**
 * Try to read the cached version-check result.
 * Returns null if the cache is missing, unreadable, or expired.
 */
async function readCache(): Promise<CachedCheck | null> {
  try {
    const raw = await readFile(CACHE_FILE, 'utf8');
    const data = JSON.parse(raw) as CachedCheck;
    if (
      typeof data.latestVersion === 'string' &&
      typeof data.checkedAt === 'number' &&
      Date.now() - data.checkedAt < TTL_MS
    ) {
      return data;
    }
  } catch {
    // missing, corrupt, or unreadable — treat as cache miss
  }
  return null;
}

async function writeCache(entry: CachedCheck): Promise<void> {
  try {
    await mkdir(CACHE_DIR, { recursive: true });
    await writeFile(CACHE_FILE, JSON.stringify(entry));
  } catch {
    // best-effort — don't let a write failure break anything
  }
}

/**
 * Fetch the latest version from npm. Returns null on any failure.
 * Uses a short timeout so it never meaningfully delays the CLI.
 */
async function fetchLatestVersion(): Promise<string | null> {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 3_000);
    const res = await fetch(REGISTRY_URL, {
      signal: controller.signal,
      headers: { Accept: 'application/json' },
    });
    clearTimeout(timer);
    if (!res.ok) return null;
    const body = (await res.json()) as { version?: string };
    return typeof body.version === 'string' ? body.version : null;
  } catch {
    return null;
  }
}

/**
 * Fire-and-forget version check. Call this early in the CLI boot path.
 * It resolves immediately (never awaited on the hot path) and prints
 * a warning to stderr if the running version is outdated.
 */
export function backgroundVersionCheck(currentVersion: string): void {
  // Intentionally not awaited — this is fire-and-forget.
  void (async () => {
    try {
      let latest: string | null = null;
      const cached = await readCache();
      if (cached) {
        latest = cached.latestVersion;
      } else {
        latest = await fetchLatestVersion();
        if (latest) {
          await writeCache({ latestVersion: latest, checkedAt: Date.now() });
        }
      }
      if (latest && compareSemver(currentVersion, latest) < 0) {
        process.stderr.write(
          yellow(
            `⚠ @freeappstore/cli v${currentVersion} is outdated. Run "npm i -g @freeappstore/cli" to get v${latest}.\n`,
          ),
        );
      }
    } catch {
      // Swallow everything — version check must never break the CLI.
    }
  })();
}
