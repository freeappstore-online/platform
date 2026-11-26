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

async function post(url: string, body: unknown, signal?: AbortSignal) {
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal,
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
  signal?: AbortSignal;
  api?: string;
  pollMs?: number;
}): Promise<string> {
  const { label, open, signal, api = API, pollMs = POLL_MS } = opts;
  const verifier = randomBytes(32).toString('hex');
  const challenge = createHash('sha256').update(verifier).digest('hex');
  const { json: started } = await post(`${api}/native/auth/start`, { challenge, label }, signal);
  const id = String(started.id);
  open(String(started.authorizationUrl));
  const expiresAt = Date.now() + Number(started.expiresIn) * 1000;
  while (Date.now() < expiresAt) {
    await wait(pollMs, signal);
    const { status, json } = await post(`${api}/native/auth/complete`, { id, verifier }, signal);
    if (status === 200 && typeof json.token === 'string') return json.token;
  }
  throw new Error('The connection expired before it was approved. Try again.');
}

/** Revoke the device credential on the server; the local copy is deleted by the caller either way. */
export async function unpairDevice(token: string, api = API): Promise<void> {
  await fetch(`${api}/native/device`, {
    method: 'DELETE',
    headers: { Authorization: `Bearer ${token}` },
  }).catch(() => {});
}
