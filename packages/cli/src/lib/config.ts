import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

const CONFIG_DIR = join(homedir(), '.fas');
const CONFIG_FILE = join(CONFIG_DIR, 'config.json');

export interface FasConfig {
  apiBase: string;
  github?: {
    accessToken: string;
    login: string;
    obtainedAt: number;
  };
  /**
   * fas session token, minted by /v1/auth/exchange. Used as a Bearer for
   * authenticated calls to the platform API. Lives 30 days; if expired,
   * `fas login` mints a new one.
   */
  session?: {
    token: string;
    obtainedAt: number;
  };
}

const DEFAULT_CONFIG: FasConfig = {
  apiBase: process.env.FAS_API_BASE ?? 'https://api.freeappstore.online',
};

/**
 * Strips trailing slashes so callers can do `${apiBase}/v1/foo` without
 * worrying about producing `https://host//v1/foo`. Defensive: a stored or
 * env-supplied value with a trailing slash is normalised on read.
 */
export function normalizeApiBase(s: string): string {
  return s.replace(/\/+$/, '');
}

/**
 * fas session lifetime. MUST match SESSION_TTL_SECONDS in the backend
 * (packages/backend/src/lib/session.ts) — the backend signs the JWT's `exp`,
 * the CLI uses this only to warn the user *before* the server 401s.
 */
export const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * Whole days until the stored session expires, computed from `obtainedAt`.
 * - `null` — no session, or a legacy config with no `obtainedAt` (can't tell;
 *   don't warn).
 * - `<= 0` — already expired (the server will 401; the user must `fas login`).
 * Lets commands give an accurate "your session expired" message instead of the
 * misleading "not signed in" (which reads as a permissions problem).
 */
export function sessionDaysRemaining(config: FasConfig): number | null {
  const obtainedAt = config.session?.obtainedAt;
  if (!config.session?.token || !obtainedAt) return null;
  const msLeft = obtainedAt + SESSION_TTL_MS - Date.now();
  // ceil so a token with 29.99 days left reads as "30 days", not "29" right
  // after login. An already-expired token still yields <= 0 (ceil of a small
  // negative is 0 or negative), which callers treat as "must re-login".
  return Math.ceil(msLeft / (24 * 60 * 60 * 1000));
}

export async function readConfig(): Promise<FasConfig> {
  try {
    const raw = await readFile(CONFIG_FILE, 'utf8');
    const parsed = JSON.parse(raw) as Partial<FasConfig>;
    const merged = { ...DEFAULT_CONFIG, ...parsed };
    return { ...merged, apiBase: normalizeApiBase(merged.apiBase) };
  } catch {
    return { ...DEFAULT_CONFIG, apiBase: normalizeApiBase(DEFAULT_CONFIG.apiBase) };
  }
}

export async function writeConfig(config: FasConfig): Promise<void> {
  await mkdir(CONFIG_DIR, { recursive: true, mode: 0o700 });
  await writeFile(CONFIG_FILE, JSON.stringify(config, null, 2), { mode: 0o600 });
  await chmod(CONFIG_FILE, 0o600);
}
