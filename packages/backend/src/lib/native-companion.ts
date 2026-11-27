/**
 * FAS native companion (#616): shared pieces of the pairing and location API.
 * Vendored from the PAS protocol (proappstore-online/platform ADR-015/016) —
 * stores copy, they don't depend on each other.
 */
import type { Context } from 'hono';
import type { Env } from '../types.js';
import { HttpError } from './auth.js';

export const NATIVE_RETENTION_MS = 7 * 24 * 60 * 60_000;
export const NATIVE_DEVICE_MS = 90 * 24 * 60 * 60_000;
/** How stale a device's last seen time may get before a request writes it again (#833). */
const SEEN_MS = 15 * 60_000;
/** How long a used or expired pairing code stays on record (#845). */
const PAIR_CODE_RECORD_MS = 30 * 24 * 60 * 60_000;
const CLIENTS = ['android', 'ios', 'desktop'];

// Curated, reviewed recipients (list order is /native/me order). An app's own
// declaration never grants a capability. Any wording change re-versions the
// contract (see nativeCatalog), which invalidates every existing grant.
const NATIVE_CATALOG = [
  {
    id: 'run',
    name: 'Run',
    capability: 'location.background',
    purpose: 'Keep recording your runs and walks while your phone is locked or Run is closed.',
    disclosure:
      'FreeAppStore collects precise location in the background to record your runs and walks for Run, including while your phone is locked and Run is closed. Coordinates are uploaded to FreeAppStore and made available to Run for your account only. Run adds them only to an activity you are recording; it ignores location outside a recording. FreeAppStore keeps its copy for 7 days. You can pause collection or turn off Run at any time. Runs you save stay in Run until you delete them.',
  },
] as const;

/** A FAS app row counts only while it is an apps-store row with this owner. */
export const NATIVE_APP_JOIN =
  "JOIN apps a ON a.id = g.app_id AND a.owner_id = g.publisher_id AND (a.store IS NULL OR a.store = 'apps')";

interface NativeDevice {
  id: string;
  user_id: string;
  label: string;
  created_at: number;
  expires_at: number;
  app_version: string | null;
  client: string | null;
  last_seen_at: number | null;
}
export interface NativeGrant {
  id: string;
  app_id: string;
  consent_at: number;
  contract_version: string;
  publisher_id: string;
}
interface NativePoint {
  id: string;
  at: number;
  lat: number;
  lng: number;
  accuracy: number;
  grants: string[];
}

const HEX64 = /^[a-f0-9]{64}$/;
export const isHex64 = (v: unknown): v is string => typeof v === 'string' && HEX64.test(v);

export function nativeRandom(): string {
  return Array.from(crypto.getRandomValues(new Uint8Array(32)), (b) =>
    b.toString(16).padStart(2, '0'),
  ).join('');
}

export async function nativeHash(value: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('');
}

/** The catalog with each entry's version bound to its exact wording. */
export async function nativeCatalog() {
  return Promise.all(
    NATIVE_CATALOG.map(async (a) => ({ ...a, version: await nativeHash(JSON.stringify(a)) })),
  );
}

/** A JSON object body of at most `max` bytes. */
export async function nativeBody(
  c: Context<{ Bindings: Env }>,
  max = 4096,
): Promise<Record<string, unknown>> {
  if (Number(c.req.header('content-length') ?? 0) > max) {
    throw new HttpError(413, 'Request is too large.');
  }
  // Count streamed bytes too: a chunked body has no Content-Length.
  const chunks: Uint8Array[] = [];
  let size = 0;
  const reader = c.req.raw.body?.getReader();
  for (;;) {
    const chunk = await reader?.read();
    if (!chunk || chunk.done) break;
    size += chunk.value.byteLength;
    if (size > max) {
      await reader!.cancel();
      throw new HttpError(413, 'Request is too large.');
    }
    chunks.push(chunk.value);
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  let body: unknown;
  try {
    body = JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    throw new HttpError(400, 'Invalid JSON request.');
  }
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw new HttpError(400, 'Expected a JSON object.');
  }
  return body as Record<string, unknown>;
}

/**
 * What the calling app says it is (#833): its version label (`X-FAS-App-Version`,
 * "0.4.0 (57, abc1234)") and kind (`X-FAS-Client`: android, ios or desktop).
 * Each is null when absent or malformed.
 */
export function nativeClient(c: Context<{ Bindings: Env }>) {
  const version = c.req.header('X-FAS-App-Version')?.trim() ?? '';
  const client = c.req.header('X-FAS-Client') ?? '';
  return {
    version: /^[\w .,()+-]{1,64}$/.test(version) ? version : null,
    client: CLIENTS.includes(client) ? client : null,
  };
}

/**
 * The device behind an `ndev_` bearer credential. Never accepts a FAS session.
 * Keeps the device's last seen version, kind and time (#833), writing only when
 * one changed or the time is older than SEEN_MS, not on every request.
 */
export async function nativeDevice(c: Context<{ Bindings: Env }>): Promise<NativeDevice> {
  const token = c.req.header('Authorization')?.replace(/^Bearer /, '') ?? '';
  if (!/^ndev_[a-f0-9]{64}$/.test(token)) {
    throw new HttpError(401, 'Connect this device to FreeAppStore.');
  }
  const now = Date.now();
  const row = await c.env.DB.prepare(
    `SELECT id, user_id, label, created_at, expires_at, app_version, client, last_seen_at
     FROM native_devices WHERE token_hash = ? AND expires_at > ?`,
  )
    .bind(await nativeHash(token), now)
    .first<NativeDevice>();
  if (!row) throw new HttpError(401, 'Device connection expired or was disconnected.');
  const { version, client } = nativeClient(c);
  if (
    (version && version !== row.app_version) ||
    (client && client !== row.client) ||
    (row.last_seen_at ?? 0) < now - SEEN_MS
  ) {
    await c.env.DB.prepare(
      'UPDATE native_devices SET app_version = COALESCE(?, app_version), client = COALESCE(?, client), last_seen_at = ? WHERE id = ?',
    )
      .bind(version, client, now, row.id)
      .run();
  }
  return row;
}

/**
 * A new device credential for `userId` (#616, #845), with the caller's version
 * and kind. Null when the account no longer exists: no foreign key to users.
 */
export async function createNativeDevice(
  c: Context<{ Bindings: Env }>,
  userId: string,
  label: string,
): Promise<{ token: string; deviceId: string } | null> {
  const deviceId = nativeRandom();
  const token = `ndev_${nativeRandom()}`;
  const now = Date.now();
  const { version, client } = nativeClient(c);
  const inserted = await c.env.DB.prepare(
    `INSERT INTO native_devices (id, user_id, label, token_hash, created_at, expires_at, app_version, client, last_seen_at)
     SELECT ?, id, ?, ?, ?, ?, ?, ?, ? FROM users WHERE id = ?`,
  )
    .bind(
      deviceId,
      label,
      await nativeHash(token),
      now,
      now + NATIVE_DEVICE_MS,
      version,
      client,
      now,
      userId,
    )
    .run();
  return inserted.meta.changes ? { token, deviceId } : null;
}

// Crockford base32: no I, L, O or U, so a code read aloud or typed is unambiguous.
const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

/** A pairing code (#845): 16 Crockford base32 characters, 80 random bits. */
export function nativePairCode(): string {
  return Array.from(crypto.getRandomValues(new Uint8Array(16)), (b) => CROCKFORD[b & 31]).join('');
}

/** A typed or scanned pairing code in its stored form, or null. Ignores case, spaces and dashes. */
export function normalizePairCode(value: unknown): string | null {
  if (typeof value !== 'string' || value.length > 64) return null;
  const code = value.toUpperCase().replace(/[\s-]/g, '').replace(/[IL]/g, '1').replace(/O/g, '0');
  return /^[0-9A-HJKMNP-TV-Z]{16}$/.test(code) ? code : null;
}

/** This device's grants that still hold: current contract, same app owner. */
export async function nativeGrants(db: D1Database, deviceId: string): Promise<NativeGrant[]> {
  const rows = await db
    .prepare(
      `SELECT g.id, g.app_id, g.consent_at, g.contract_version, g.publisher_id
       FROM native_grants g ${NATIVE_APP_JOIN} WHERE g.device_id = ?`,
    )
    .bind(deviceId)
    .all<NativeGrant>();
  const catalog = await nativeCatalog();
  return (rows.results ?? []).filter((g) =>
    catalog.some((a) => a.id === g.app_id && a.version === g.contract_version),
  );
}

export function nativePoints(value: unknown, now: number): NativePoint[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > 100) {
    throw new HttpError(400, 'Send 1 to 100 location points.');
  }
  const ids = new Set<string>();
  return value.map((p) => {
    if (
      !p ||
      typeof p.id !== 'string' ||
      !/^[A-Za-z0-9-]{1,80}$/.test(p.id) ||
      ids.has(p.id) ||
      !Number.isSafeInteger(p.at) ||
      p.at < now - NATIVE_RETENTION_MS ||
      p.at > now + 60_000 ||
      typeof p.lat !== 'number' ||
      !Number.isFinite(p.lat) ||
      Math.abs(p.lat) > 90 ||
      typeof p.lng !== 'number' ||
      !Number.isFinite(p.lng) ||
      Math.abs(p.lng) > 180 ||
      typeof p.accuracy !== 'number' ||
      !Number.isFinite(p.accuracy) ||
      p.accuracy < 0 ||
      p.accuracy > 10_000 ||
      !Array.isArray(p.grants) ||
      p.grants.length < 1 ||
      p.grants.length > 10 ||
      p.grants.some((g: unknown) => !isHex64(g))
    ) {
      throw new HttpError(400, 'Invalid location point.');
    }
    ids.add(p.id);
    return {
      id: p.id,
      at: p.at,
      lat: p.lat,
      lng: p.lng,
      accuracy: p.accuracy,
      grants: [...new Set<string>(p.grants)],
    };
  });
}

/** Physically drop expired points, pairings, devices, old pairing codes and grants whose app changed hands. */
export async function pruneNativeData(db: D1Database, now: number): Promise<void> {
  await db.batch([
    db
      .prepare('DELETE FROM native_locations WHERE recorded_at < ?')
      .bind(now - NATIVE_RETENTION_MS),
    db.prepare('DELETE FROM native_pairings WHERE expires_at <= ?').bind(now),
    db.prepare('DELETE FROM native_devices WHERE expires_at <= ?').bind(now),
    db
      .prepare('DELETE FROM native_pair_codes WHERE expires_at <= ?')
      .bind(now - PAIR_CODE_RECORD_MS),
    db.prepare(
      `DELETE FROM native_grants WHERE id NOT IN (SELECT g.id FROM native_grants g ${NATIVE_APP_JOIN})`,
    ),
  ]);
}
