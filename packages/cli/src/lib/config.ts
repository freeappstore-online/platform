import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

const CONFIG_DIR = join(homedir(), '.fas');
const CONFIG_FILE = join(CONFIG_DIR, 'config.json');

export interface FasConfig {
  apiBase: string;
  /** Only the login is kept: the GitHub token is used once, to mint the fas session, and dropped. */
  github?: {
    login: string;
  };
  /**
   * fas session token, minted by /v1/auth/exchange. Used as a Bearer for
   * authenticated calls to the platform API. Lives 30 days; if expired,
   * `fas login` mints a new one.
   */
  session?: {
    token: string;
  };
}

const DEFAULT_API_BASE = 'https://api.freeappstore.online';

/**
 * Strips trailing slashes so callers can do `${apiBase}/v1/foo` without
 * worrying about producing `https://host//v1/foo`. Defensive: a stored or
 * env-supplied value with a trailing slash is normalised on read.
 */
export function normalizeApiBase(s: string): string {
  return s.replace(/\/+$/, '');
}

/**
 * Whole days until the stored session expires, read from the token's own `exp`
 * claim (the token is `<base64url JSON payload>.<signature>`), so the CLI has
 * no copy of the backend's lifetime to keep in step.
 * - `null` — no session, or a token whose payload can't be read (don't warn).
 * - `<= 0` — already expired (the server will 401; the user must `fas login`).
 * Lets commands give an accurate "your session expired" message instead of the
 * misleading "not signed in" (which reads as a permissions problem).
 */
export function sessionDaysRemaining(config: FasConfig): number | null {
  const token = config.session?.token;
  if (!token) return null;
  let exp: unknown;
  try {
    exp = JSON.parse(Buffer.from(token.slice(0, token.lastIndexOf('.')), 'base64url').toString()).exp;
  } catch {
    return null;
  }
  if (typeof exp !== 'number') return null;
  // ceil so a token with 29.99 days left reads as "30 days", not "29" right
  // after login. An already-expired token still yields <= 0.
  return Math.ceil((exp * 1000 - Date.now()) / (24 * 60 * 60 * 1000));
}

/**
 * The API host every command (and the login token exchange) talks to: the
 * default, or `FAS_API_BASE` for this run only (#520). It is never read from or
 * written to the config file, so one run with the variable set cannot redirect
 * later logins. Must be https, except for localhost development.
 */
export function resolveApiBase(override = process.env.FAS_API_BASE): string {
  if (!override) return DEFAULT_API_BASE;
  let url: URL;
  try {
    url = new URL(override);
  } catch {
    throw new Error(`FAS_API_BASE is not a valid URL: ${override}`);
  }
  const local = url.hostname === 'localhost' || url.hostname === '127.0.0.1';
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && local)) {
    throw new Error(
      'FAS_API_BASE must be an https:// URL (http:// is allowed only for localhost).',
    );
  }
  return normalizeApiBase(override);
}

export async function readConfig(): Promise<FasConfig> {
  let parsed: Partial<FasConfig> = {};
  try {
    parsed = JSON.parse(await readFile(CONFIG_FILE, 'utf8')) as Partial<FasConfig>;
  } catch {
    // missing, corrupt or unreadable — start from the defaults
  }
  // A stored apiBase (written by older versions, possibly from an env override)
  // is ignored.
  return { ...parsed, apiBase: resolveApiBase() };
}

export async function writeConfig(config: FasConfig): Promise<void> {
  // apiBase is never persisted (#520), and a GitHub access token left in an
  // older config is dropped on the next write (#481).
  const { apiBase: _apiBase, github, ...rest } = config;
  const persisted = { ...rest, ...(github ? { github: { login: github.login } } : {}) };
  await mkdir(CONFIG_DIR, { recursive: true, mode: 0o700 });
  await chmod(CONFIG_DIR, 0o700);
  await writeFile(CONFIG_FILE, JSON.stringify(persisted, null, 2), { mode: 0o600 });
  await chmod(CONFIG_FILE, 0o600);
}
