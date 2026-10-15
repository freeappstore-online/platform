import { type Context, Hono } from 'hono';
import { appExists } from '../lib/apps.js';
import { HttpError, requireUser } from '../lib/auth.js';
import {
  firstOccurrence,
  formatTime,
  isValidTimeZone,
  type PushRule,
  parseRule,
  parseTime,
} from '../lib/push-schedule.js';
import { PUSH_LIMITS } from '../lib/quota.js';
import type { Env } from '../types.js';

/**
 * `fas.push` (#145, #146). Apps register a browser's Web Push subscription
 * per (appId, userId), like kv, and reminder schedules for the user; the
 * backend's cron (lib/push-delivery.ts) sends a no-payload push to the
 * user's devices when a schedule comes due. The platform VAPID key pair signs
 * the pushes.
 */
export const pushRoutes = new Hono<{ Bindings: Env }>();

/**
 * Push services that browsers hand out endpoints for. Anything else is
 * rejected so a stored "subscription" can't turn the push sender into an
 * SSRF probe. Same services as the agent's /push-subscribe allowlist
 * (workers/agent/src/session.ts), matched as exact host or subdomain.
 */
const PUSH_SERVICE_HOSTS = [
  'push.services.mozilla.com', // Firefox
  'fcm.googleapis.com', // Chrome, Edge on Android, Opera, Samsung
  'android.googleapis.com', // older Chrome (GCM-era endpoints)
  'notify.windows.com', // Edge on Windows (WNS)
  'push.apple.com', // Safari / iOS web push (web.push.apple.com)
];

export function isAllowedPushEndpoint(endpoint: string): boolean {
  if (endpoint.length > PUSH_LIMITS.maxEndpointLength) return false;
  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    return false;
  }
  if (url.protocol !== 'https:' || url.username || url.password || url.port) return false;
  const host = url.hostname.toLowerCase();
  return PUSH_SERVICE_HOSTS.some((h) => host === h || host.endsWith(`.${h}`));
}

/** Decodes base64url (padding optional); null if it isn't valid base64url. */
function base64UrlBytes(value: string): Uint8Array | null {
  if (!/^[A-Za-z0-9_-]+={0,2}$/.test(value)) return null;
  const b64 = value.replace(/=+$/, '').replace(/-/g, '+').replace(/_/g, '/');
  try {
    const bin = atob(b64 + '='.repeat((4 - (b64.length % 4)) % 4));
    return Uint8Array.from(bin, (ch) => ch.charCodeAt(0));
  } catch {
    return null;
  }
}

/** p256dh is an uncompressed P-256 point: 65 bytes starting 0x04. */
function isValidP256dh(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  const bytes = base64UrlBytes(value);
  return bytes !== null && bytes.length === 65 && bytes[0] === 0x04;
}

/** auth is the 16-byte subscription auth secret. */
function isValidAuth(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  return base64UrlBytes(value)?.length === 16;
}

/**
 * Reads a small JSON body with the push size cap enforced before and after
 * reading. Throws HttpError(413) when too large and HttpError(400) when it
 * isn't a JSON object.
 */
async function readJsonBody(c: Context<{ Bindings: Env }>): Promise<Record<string, unknown>> {
  const declared = Number(c.req.header('content-length') ?? 0);
  if (declared > PUSH_LIMITS.maxBodyBytes) {
    throw new HttpError(413, `request body exceeds ${PUSH_LIMITS.maxBodyBytes} bytes`);
  }
  const text = await c.req.text();
  if (new TextEncoder().encode(text).byteLength > PUSH_LIMITS.maxBodyBytes) {
    throw new HttpError(413, `request body exceeds ${PUSH_LIMITS.maxBodyBytes} bytes`);
  }
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    throw new HttpError(400, 'body must be JSON');
  }
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw new HttpError(400, 'body must be a JSON object');
  }
  return body as Record<string, unknown>;
}

/** Signed-in user plus a known app id, or an HttpError (401 / 404). */
async function requireAppUser(c: Context<{ Bindings: Env }>) {
  const user = await requireUser(c);
  const { appId } = c.req.param() as { appId: string };
  if (!(await appExists(c.env, appId))) throw new HttpError(404, 'unknown app');
  return { user, appId };
}

const errorResponse = (c: Context<{ Bindings: Env }>, err: unknown) => {
  if (err instanceof HttpError) return c.json({ error: err.message }, err.status as 400);
  throw err;
};

/** Public: the VAPID public key apps pass to pushManager.subscribe(). */
pushRoutes.get('/push/vapid-public-key', (c) => {
  const publicKey = c.env.VAPID_PUBLIC_KEY;
  if (!publicKey) {
    c.header('Cache-Control', 'no-store');
    return c.json({ error: 'push is not configured: VAPID_PUBLIC_KEY is not set' }, 503);
  }
  c.header('Cache-Control', 'public, max-age=3600');
  return c.json({ publicKey });
});

/**
 * Registers (or refreshes) this device's subscription for the current user
 * and app. Upserts by endpoint: the same browser re-subscribing updates its
 * keys, and an endpoint previously registered to another user or app moves
 * here. 201 for a new device for this (app, user), 200 when it was already
 * theirs.
 */
pushRoutes.post('/apps/:appId/push/subscriptions', async (c) => {
  try {
    const { user, appId } = await requireAppUser(c);
    const body = await readJsonBody(c);
    const endpoint = body.endpoint;
    const keys = (body.keys ?? {}) as Record<string, unknown>;
    if (typeof endpoint !== 'string' || !isAllowedPushEndpoint(endpoint)) {
      return c.json({ error: 'endpoint must be an https URL on a known push service' }, 400);
    }
    if (!isValidP256dh(keys.p256dh)) {
      return c.json({ error: 'keys.p256dh must be a base64url 65-byte P-256 public key' }, 400);
    }
    if (!isValidAuth(keys.auth)) {
      return c.json({ error: 'keys.auth must be a base64url 16-byte secret' }, 400);
    }

    const usage = await c.env.DB.prepare(
      `SELECT COUNT(*) AS n,
         COALESCE(SUM(CASE WHEN endpoint = ? THEN 1 ELSE 0 END), 0) AS mine
       FROM push_subscriptions WHERE app_id = ? AND user_id = ?`,
    )
      .bind(endpoint, appId, user.id)
      .first<{ n: number; mine: number }>();
    const alreadyMine = (usage?.mine ?? 0) > 0;
    if (!alreadyMine && (usage?.n ?? 0) >= PUSH_LIMITS.maxSubscriptionsPerUser) {
      return c.json(
        {
          error: `per-user push subscription limit (${PUSH_LIMITS.maxSubscriptionsPerUser}) exceeded for this app`,
        },
        413,
      );
    }

    const userAgent = c.req.header('user-agent')?.slice(0, 512) ?? null;
    // On conflict the row keeps its history only if it stays with the same
    // (app, user); a device that changes hands starts fresh.
    const row = await c.env.DB.prepare(
      `INSERT INTO push_subscriptions
         (id, app_id, user_id, endpoint, p256dh, auth, user_agent, created_at, failure_count)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0)
       ON CONFLICT(endpoint) DO UPDATE SET
         created_at = CASE WHEN push_subscriptions.app_id = excluded.app_id
             AND push_subscriptions.user_id = excluded.user_id
           THEN push_subscriptions.created_at ELSE excluded.created_at END,
         last_success_at = CASE WHEN push_subscriptions.app_id = excluded.app_id
             AND push_subscriptions.user_id = excluded.user_id
           THEN push_subscriptions.last_success_at ELSE NULL END,
         app_id = excluded.app_id,
         user_id = excluded.user_id,
         p256dh = excluded.p256dh,
         auth = excluded.auth,
         user_agent = excluded.user_agent,
         failure_count = 0
       RETURNING id, created_at`,
    )
      .bind(
        crypto.randomUUID(),
        appId,
        user.id,
        endpoint,
        keys.p256dh,
        keys.auth,
        userAgent,
        Date.now(),
      )
      .first<{ id: string; created_at: number }>();

    return c.json({ id: row?.id, endpoint, createdAt: row?.created_at }, alreadyMine ? 200 : 201);
  } catch (err) {
    return errorResponse(c, err);
  }
});

/** Removes this device's subscription (by endpoint) for the current user and app. */
pushRoutes.delete('/apps/:appId/push/subscriptions', async (c) => {
  try {
    const { user, appId } = await requireAppUser(c);
    const body = await readJsonBody(c);
    if (typeof body.endpoint !== 'string' || body.endpoint.length === 0) {
      return c.json({ error: 'endpoint is required' }, 400);
    }
    const result = await c.env.DB.prepare(
      'DELETE FROM push_subscriptions WHERE endpoint = ? AND app_id = ? AND user_id = ?',
    )
      .bind(body.endpoint, appId, user.id)
      .run();
    if (result.meta.changes === 0) return c.json({ error: 'not found' }, 404);
    return c.body(null, 204);
  } catch (err) {
    return errorResponse(c, err);
  }
});

/** This user's registered devices for this app (for a settings screen). Keys are not returned. */
pushRoutes.get('/apps/:appId/push/subscriptions', async (c) => {
  try {
    const { user, appId } = await requireAppUser(c);
    const { results } = await c.env.DB.prepare(
      `SELECT id, endpoint, user_agent, created_at, last_success_at, failure_count
       FROM push_subscriptions WHERE app_id = ? AND user_id = ?
       ORDER BY created_at DESC`,
    )
      .bind(appId, user.id)
      .all<{
        id: string;
        endpoint: string;
        user_agent: string | null;
        created_at: number;
        last_success_at: number | null;
        failure_count: number;
      }>();
    return c.json({
      subscriptions: (results ?? []).map((r) => ({
        id: r.id,
        endpoint: r.endpoint,
        userAgent: r.user_agent,
        createdAt: r.created_at,
        lastSuccessAt: r.last_success_at,
        failureCount: r.failure_count,
      })),
    });
  } catch (err) {
    return errorResponse(c, err);
  }
});

// ── Reminder schedules (#146) ───────────────────────────────────────────

const REMINDER_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

interface ScheduleRow {
  reminder_id: string;
  next_at: number;
  rule: string;
  tz: string;
  quiet_start: number | null;
  quiet_end: number | null;
  created_at: number;
}

const scheduleJson = (r: ScheduleRow) => ({
  reminderId: r.reminder_id,
  rule: JSON.parse(r.rule) as PushRule,
  tz: r.tz,
  quietHours:
    r.quiet_start === null || r.quiet_end === null
      ? null
      : { start: formatTime(r.quiet_start), end: formatTime(r.quiet_end) },
  nextAt: r.next_at,
  createdAt: r.created_at,
});

/**
 * Creates or replaces a reminder for the current user in this app. Body:
 * `{ rule, tz, quietHours? }`: rule is `{ type: 'at', at }` (ms or ISO),
 * `{ type: 'daily', time: 'HH:MM' }` or `{ type: 'every', days, time }`; tz is
 * an IANA zone; quietHours is `{ start: 'HH:MM', end: 'HH:MM' }`. 201 when
 * new, 200 when replaced.
 */
pushRoutes.put('/apps/:appId/push/schedules/:reminderId', async (c) => {
  try {
    const { user, appId } = await requireAppUser(c);
    const reminderId = c.req.param('reminderId');
    if (!REMINDER_ID_RE.test(reminderId)) {
      return c.json({ error: 'reminderId must be 1-64 letters, digits, _ or -' }, 400);
    }
    const body = await readJsonBody(c);
    if (!isValidTimeZone(body.tz)) return c.json({ error: 'tz must be an IANA time zone' }, 400);
    const now = Date.now();
    const parsed = parseRule(body.rule, now);
    if ('error' in parsed) return c.json({ error: parsed.error }, 400);
    let quietStart: number | null = null;
    let quietEnd: number | null = null;
    if (body.quietHours !== undefined && body.quietHours !== null) {
      const q = body.quietHours as Record<string, unknown>;
      quietStart = parseTime(q?.start);
      quietEnd = parseTime(q?.end);
      if (quietStart === null || quietEnd === null) {
        return c.json(
          { error: 'quietHours.start and quietHours.end must be HH:MM (24-hour)' },
          400,
        );
      }
    }

    const usage = await c.env.DB.prepare(
      `SELECT COUNT(*) AS n,
         COALESCE(SUM(CASE WHEN reminder_id = ? THEN 1 ELSE 0 END), 0) AS mine
       FROM push_schedules WHERE app_id = ? AND user_id = ?`,
    )
      .bind(reminderId, appId, user.id)
      .first<{ n: number; mine: number }>();
    const exists = (usage?.mine ?? 0) > 0;
    if (!exists && (usage?.n ?? 0) >= PUSH_LIMITS.maxSchedulesPerUser) {
      return c.json(
        {
          error: `per-user reminder limit (${PUSH_LIMITS.maxSchedulesPerUser}) exceeded for this app`,
        },
        413,
      );
    }

    const nextAt = firstOccurrence(parsed.rule, body.tz, now);
    const row = await c.env.DB.prepare(
      `INSERT INTO push_schedules
         (id, app_id, user_id, reminder_id, next_at, occurrence_at, rule, tz, quiet_start, quiet_end, attempts, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?)
       ON CONFLICT(app_id, user_id, reminder_id) DO UPDATE SET
         next_at = excluded.next_at, occurrence_at = excluded.occurrence_at, rule = excluded.rule, tz = excluded.tz,
         quiet_start = excluded.quiet_start, quiet_end = excluded.quiet_end, attempts = 0
       RETURNING reminder_id, next_at, rule, tz, quiet_start, quiet_end, created_at`,
    )
      .bind(
        crypto.randomUUID(),
        appId,
        user.id,
        reminderId,
        nextAt,
        nextAt,
        JSON.stringify(parsed.rule),
        body.tz,
        quietStart,
        quietEnd,
        now,
      )
      .first<ScheduleRow>();
    if (!row) throw new Error('push schedule upsert returned no row');
    return c.json(scheduleJson(row), exists ? 200 : 201);
  } catch (err) {
    return errorResponse(c, err);
  }
});

/** Cancels one reminder. 204, or 404 if this user has no such reminder in this app. */
pushRoutes.delete('/apps/:appId/push/schedules/:reminderId', async (c) => {
  try {
    const { user, appId } = await requireAppUser(c);
    const result = await c.env.DB.prepare(
      'DELETE FROM push_schedules WHERE app_id = ? AND user_id = ? AND reminder_id = ?',
    )
      .bind(appId, user.id, c.req.param('reminderId'))
      .run();
    if (result.meta.changes === 0) return c.json({ error: 'not found' }, 404);
    return c.body(null, 204);
  } catch (err) {
    return errorResponse(c, err);
  }
});

/** This user's reminders for this app, soonest first. */
pushRoutes.get('/apps/:appId/push/schedules', async (c) => {
  try {
    const { user, appId } = await requireAppUser(c);
    const { results } = await c.env.DB.prepare(
      `SELECT reminder_id, next_at, rule, tz, quiet_start, quiet_end, created_at
       FROM push_schedules WHERE app_id = ? AND user_id = ? ORDER BY next_at`,
    )
      .bind(appId, user.id)
      .all<ScheduleRow>();
    return c.json({ schedules: (results ?? []).map(scheduleJson) });
  } catch (err) {
    return errorResponse(c, err);
  }
});
