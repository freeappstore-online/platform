import { createHash, randomBytes } from 'node:crypto';
import { chmodSync, existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * This computer's FreeAppStore device credential (`ndev_…`) for Contribute (#826), from the native
 * device pairing the phone apps use (#616, docs/native-companion.md): the desktop app has no FAS
 * sign-in of its own. Kept in userData as `device-token`, mode 0600, never logged.
 */
export const API_ORIGIN = 'https://api.freeappstore.online';
export const API = `${API_ORIGIN}/v1`;
const FILE = 'device-token';

/** What this app is (#833): sent with pairing and every call with the device credential. */
export const clientHeaders = (version: string) => ({
  'X-FAS-App-Version': version,
  'X-FAS-Client': 'desktop',
});
/** How often a pairing in progress asks whether the user approved it. */
const POLL_MS = 2000;

export function loadDeviceToken(dir: string): string | null {
  const path = join(dir, FILE);
  if (!existsSync(path)) return null;
  return readFileSync(path, 'utf8').trim() || null;
}

export function saveDeviceToken(dir: string, token: string): void {
  const path = join(dir, FILE);
  writeFileSync(path, token, { mode: 0o600 });
  chmodSync(path, 0o600);
}

export function deleteDeviceToken(dir: string): void {
  rmSync(join(dir, FILE), { force: true });
}

const wait = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener('abort', () => {
      clearTimeout(timer);
      reject(signal.reason);
    });
  });

async function post(
  url: string,
  body: unknown,
  headers: Record<string, string>,
  signal?: AbortSignal,
) {
  const response = await fetch(url, {
    redirect: 'error',
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(body),
    signal: signal
      ? AbortSignal.any([signal, AbortSignal.timeout(20_000)])
      : AbortSignal.timeout(20_000),
  });
  const json = (await response.json().catch(() => ({}))) as Record<string, unknown>;
  if (!response.ok) throw new Error(String(json.error ?? `HTTP ${response.status}`));
  return { status: response.status, json };
}

/**
 * Pair this computer: start a pairing with a hashed verifier, `open` the approval page in the
 * user's browser (sign in, approve), then redeem the approval with the verifier for a device
 * token. Rejects once the pairing expires, on a refusal, or when `signal` aborts.
 */
export async function pairDevice(opts: {
  label: string;
  open: (url: string) => void;
  headers: Record<string, string>;
  signal?: AbortSignal;
  api?: string;
  pollMs?: number;
}): Promise<string> {
  const { label, open, headers, signal, api = API, pollMs = POLL_MS } = opts;
  const verifier = randomBytes(32).toString('hex');
  const challenge = createHash('sha256').update(verifier).digest('hex');
  const { json: started } = await post(
    `${api}/native/auth/start`,
    { challenge, label },
    headers,
    signal,
  );
  const id = String(started.id);
  open(String(started.authorizationUrl));
  const expiresAt = Date.now() + Number(started.expiresIn) * 1000;
  while (Date.now() < expiresAt) {
    await wait(pollMs, signal);
    const { status, json } = await post(
      `${api}/native/auth/complete`,
      { id, verifier },
      headers,
      signal,
    );
    if (status === 200 && typeof json.token === 'string') return json.token;
  }
  throw new Error('The connection expired before it was approved. Try again.');
}

/** Revoke the device credential on the server; the local copy is deleted by the caller either way. */
export async function unpairDevice(
  token: string,
  headers: Record<string, string>,
  api = API,
): Promise<void> {
  await fetch(`${api}/native/device`, {
    redirect: 'error',
    signal: AbortSignal.timeout(20_000),
    method: 'DELETE',
    headers: { ...headers, Authorization: `Bearer ${token}` },
  }).catch(() => {});
}

/** A code another phone scans to join this account (#845): 5 minutes, single use. */
export interface PairCode {
  code: string;
  url: string;
  expiresAt: number;
}

export async function createPairCode(
  token: string,
  headers: Record<string, string>,
  api = API,
): Promise<PairCode> {
  const response = await fetch(`${api}/native/pair-codes`, {
    redirect: 'error',
    signal: AbortSignal.timeout(20_000),
    method: 'POST',
    headers: { ...headers, Authorization: `Bearer ${token}` },
  });
  const json = (await response.json().catch(() => ({}))) as Record<string, unknown>;
  if (!response.ok) throw new Error(String(json.error ?? `HTTP ${response.status}`));
  return json as unknown as PairCode;
}

/** The signed-in account and this computer's connection, from `GET /native/me` (#829). */
export interface Profile {
  user: {
    id: string;
    name: string;
    /** The GitHub login; null for Google, Apple and email accounts. */
    login: string | null;
    provider: string;
    avatarUrl: string | null;
    email: string | null;
    roles: string[];
    appCount: number;
  };
  device: { id: string; label: string; createdAt: number; expiresAt: number };
}

/** The account behind `token`, or null when the credential was refused (expired or revoked). */
export async function fetchProfile(
  token: string,
  headers: Record<string, string>,
  api = API,
): Promise<Profile | null> {
  const response = await fetch(`${api}/native/me`, {
    redirect: 'error',
    signal: AbortSignal.timeout(20_000),
    headers: { ...headers, Authorization: `Bearer ${token}` },
  });
  if (response.status === 401) return null;
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const { user, device } = (await response.json()) as Profile;
  return { user, device };
}

/** Read-only queue preview; never claims work (#861). */
export interface BacklogJob {
  id: string;
  appId: string;
  key: string;
  inputPreview: string;
  inputChars: number;
  createdAt: number;
  model: string;
  modelVersion: string;
}
export interface GenerationBacklog {
  jobs: BacklogJob[];
  hasMore: boolean;
}
export async function fetchBacklog(
  token: string,
  headers: Record<string, string>,
  api = API,
): Promise<GenerationBacklog> {
  const response = await fetch(`${api}/generation/backlog`, {
    redirect: 'error',
    signal: AbortSignal.timeout(20_000),
    headers: { ...headers, Authorization: `Bearer ${token}` },
  });
  if (!response.ok) throw new Error(`Couldn't load the backlog (HTTP ${response.status}).`);
  return (await response.json()) as GenerationBacklog;
}
