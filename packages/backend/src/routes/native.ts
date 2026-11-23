/**
 * Native companion API (#616).
 *
 * Device side (`ndev_` bearer only): /native/me, per-app location grants,
 * point upload, disconnect. App side: an app reads its own users' points and
 * the companion status with a session delivered to that app (`aud` = app id).
 * Console, cross-store and other-app sessions are refused: location reaches an
 * app only through that app.
 */
import { type Context, Hono } from 'hono';
import { HttpError, requireUser } from '../lib/auth.js';
import {
  NATIVE_APP_JOIN,
  NATIVE_RETENTION_MS,
  nativeBody,
  nativeCatalog,
  nativeDevice,
  nativeGrants,
  nativePoints,
  nativeRandom,
} from '../lib/native-companion.js';
import { d1UsageStore, dayKey } from '../lib/proxy-rate-limit.js';
import type { Env } from '../types.js';

export const nativeRoutes = new Hono<{ Bindings: Env }>();

// A 15 s upload cadence around the clock is 5,760 batches a day.
const UPLOADS_PER_DEVICE_PER_DAY = 6_000;

nativeRoutes.use('/native/*', async (c, next) => {
  c.header('Cache-Control', 'private, no-store');
  await next();
});

const appRow = (db: D1Database, appId: string) =>
  db
    .prepare(
      "SELECT owner_id FROM apps WHERE id = ? AND owner_id IS NOT NULL AND (store IS NULL OR store = 'apps')",
    )
    .bind(appId)
    .first<{ owner_id: string }>();

nativeRoutes.get('/native/me', async (c) => {
  const device = await nativeDevice(c);
  const user = await c.env.DB.prepare(
    'SELECT id, github_login, display_name FROM users WHERE id = ?',
  )
    .bind(device.user_id)
    .first<{ id: string; github_login: string; display_name: string | null }>();
  if (!user) throw new HttpError(401, 'Account no longer exists.');
  const grants = await nativeGrants(c.env.DB, device.id);
  const apps = [];
  for (const a of await nativeCatalog()) {
    if (await appRow(c.env.DB, a.id)) {
      apps.push({ ...a, grant: grants.find((g) => g.app_id === a.id) ?? null });
    }
  }
  return c.json({
    user: { id: user.id, name: user.display_name || user.github_login },
    device: { id: device.id, label: device.label, expiresAt: device.expires_at },
    apps,
  });
});

nativeRoutes.put('/native/apps/:appId/location', async (c) => {
  const device = await nativeDevice(c);
  const appId = c.req.param('appId');
  const definition = (await nativeCatalog()).find((a) => a.id === appId);
  if (!definition) throw new HttpError(404, 'This app has no reviewed native location capability.');
  const body = await nativeBody(c);
  if (body.enabled !== true || body.version !== definition.version) {
    throw new HttpError(400, 'Review the current location disclosure before enabling.');
  }
  const app = await appRow(c.env.DB, appId);
  if (!app) throw new HttpError(404, 'App no longer exists.');
  const current = (await nativeGrants(c.env.DB, device.id)).find((g) => g.app_id === appId);
  if (current) return c.json({ grant: current });
  // Replace an obsolete grant; the cascade removes its points. A new consent
  // never adopts points queued under the old one.
  const id = nativeRandom();
  await c.env.DB.batch([
    c.env.DB.prepare('DELETE FROM native_grants WHERE device_id = ? AND app_id = ?').bind(
      device.id,
      appId,
    ),
    c.env.DB.prepare(
      `INSERT INTO native_grants (id, device_id, app_id, publisher_id, capability, contract_version, consent_at)
       SELECT ?, ?, id, owner_id, 'location.background', ?, ? FROM apps WHERE id = ? AND owner_id = ?`,
    ).bind(id, device.id, definition.version, Date.now(), appId, app.owner_id),
  ]);
  const grant = (await nativeGrants(c.env.DB, device.id)).find((g) => g.id === id);
  if (!grant) throw new HttpError(409, 'App changed. Review its disclosure again.');
  return c.json({ grant });
});

nativeRoutes.delete('/native/apps/:appId/location', async (c) => {
  const device = await nativeDevice(c);
  await c.env.DB.prepare('DELETE FROM native_grants WHERE device_id = ? AND app_id = ?')
    .bind(device.id, c.req.param('appId'))
    .run();
  return c.json({ revoked: true });
});

nativeRoutes.delete('/native/device', async (c) => {
  const device = await nativeDevice(c);
  await c.env.DB.prepare('DELETE FROM native_devices WHERE id = ?').bind(device.id).run();
  return c.json({ disconnected: true });
});

nativeRoutes.post('/native/locations', async (c) => {
  const device = await nativeDevice(c);
  const now = Date.now();
  const allowed = await d1UsageStore(c.env.DB).bumpIfBelow!(
    `nativeup:${device.id}`,
    dayKey(now),
    1,
    UPLOADS_PER_DEVICE_PER_DAY,
  );
  if (!allowed) throw new HttpError(429, 'Upload limit reached. Retry later.');
  const points = nativePoints((await nativeBody(c, 80_000)).points, now);
  const grants = await nativeGrants(c.env.DB, device.id);
  const statements: D1PreparedStatement[] = [];
  for (const point of points) {
    for (const grant of grants) {
      if (!point.grants.includes(grant.id) || point.at < grant.consent_at) continue;
      // Recheck consent and owner AT THE WRITE, including a revocation racing this request.
      statements.push(
        c.env.DB.prepare(
          `INSERT OR IGNORE INTO native_locations (grant_id, point_id, recorded_at, latitude, longitude, accuracy)
           SELECT g.id, ?, ?, ?, ?, ? FROM native_grants g ${NATIVE_APP_JOIN}
           JOIN native_devices d ON d.id = g.device_id
           WHERE g.id = ? AND g.device_id = ? AND g.contract_version = ? AND d.expires_at > ?`,
        ).bind(
          point.id,
          point.at,
          point.lat,
          point.lng,
          point.accuracy,
          grant.id,
          device.id,
          grant.contract_version,
          now,
        ),
      );
    }
  }
  if (statements.length) await c.env.DB.batch(statements);
  // Points for revoked recipients are dropped on purpose, never retried into a later grant.
  return c.json({ acknowledged: points.map((p) => p.id) });
});

/** The signed-in user, only through a session delivered to this very app. */
async function appUser(c: Context<{ Bindings: Env }>) {
  const appId = c.req.param('appId')!;
  const user = await requireUser(c);
  if (user.aud !== appId)
    throw new HttpError(403, 'Read location through the app it was shared with.');
  return { user, appId };
}

nativeRoutes.get('/apps/:appId/native/locations', async (c) => {
  c.header('Cache-Control', 'private, no-store');
  const { user, appId } = await appUser(c);
  const definition = (await nativeCatalog()).find((a) => a.id === appId);
  if (!definition) throw new HttpError(404, 'Native location is unavailable for this app.');
  const after = Number(c.req.query('after') ?? '0');
  const afterId = c.req.query('afterId') ?? '';
  if (!Number.isSafeInteger(after) || after < 0 || afterId.length > 160) {
    throw new HttpError(400, 'Invalid location cursor.');
  }
  const now = Date.now();
  // Composite cursor stays stable when several devices record at the same millisecond.
  const rows = await c.env.DB.prepare(
    `SELECT p.point_id AS id, p.grant_id AS grantId, p.recorded_at AS at,
       p.latitude AS lat, p.longitude AS lng, p.accuracy, p.grant_id || ':' || p.point_id AS cursorId
     FROM native_locations p JOIN native_grants g ON g.id = p.grant_id
     JOIN native_devices d ON d.id = g.device_id ${NATIVE_APP_JOIN}
     WHERE g.app_id = ? AND d.user_id = ? AND g.contract_version = ? AND d.expires_at > ? AND p.recorded_at >= ?
       AND (p.recorded_at > ? OR (p.recorded_at = ? AND p.grant_id || ':' || p.point_id > ?))
     ORDER BY p.recorded_at, cursorId LIMIT 500`,
  )
    .bind(appId, user.id, definition.version, now, now - NATIVE_RETENTION_MS, after, after, afterId)
    .all();
  return c.json({ points: rows.results ?? [] });
});

// Lets the app show companion state before any point exists. Exposes no device
// identity. Same predicates as the locations read, so status never says
// enabled while that read would return nothing.
nativeRoutes.get('/apps/:appId/native/status', async (c) => {
  c.header('Cache-Control', 'private, no-store');
  const { user, appId } = await appUser(c);
  const definition = (await nativeCatalog()).find((a) => a.id === appId);
  if (!definition) return c.json({ available: false, enabled: false, lastPointAt: null });
  const now = Date.now();
  const row = await c.env.DB.prepare(
    `SELECT COUNT(DISTINCT g.id) AS grants, MAX(p.recorded_at) AS lastPointAt
     FROM native_grants g JOIN native_devices d ON d.id = g.device_id ${NATIVE_APP_JOIN}
     LEFT JOIN native_locations p ON p.grant_id = g.id AND p.recorded_at >= ?
     WHERE g.app_id = ? AND d.user_id = ? AND g.contract_version = ? AND d.expires_at > ?`,
  )
    .bind(now - NATIVE_RETENTION_MS, appId, user.id, definition.version, now)
    .first<{ grants: number; lastPointAt: number | null }>();
  return c.json({
    available: true,
    enabled: (row?.grants ?? 0) > 0,
    lastPointAt: row?.lastPointAt ?? null,
  });
});
