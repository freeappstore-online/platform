import type { Env } from '../types.js';
import { inQuietHours, nextOccurrence, type PushRule, quietHoursEnd } from './push-schedule.js';
import {
  type PushSubscription,
  pushAudience,
  sendWebPush,
  vapidAuthorization,
  type WebPushResult,
} from './web-push.js';

/**
 * Scheduled Web Push delivery (#146), run on the backend's `*\/15` cron tick.
 *
 * Each tick takes the due reminders (push_schedules.next_at <= now), sends a
 * no-payload push to every device the user registered for that app
 * (push_subscriptions), then advances repeating reminders and deletes
 * one-shots. Per device: 404/410 means the push service dropped the
 * subscription, so it is deleted; any other failure bumps failure_count and
 * the device is dropped after MAX_DEVICE_FAILURES in a row. A reminder that
 * reached no device only because of transient errors is retried on later
 * ticks, up to MAX_ATTEMPTS, before it moves on.
 *
 * Without the platform VAPID keys nothing can be signed: the tick logs a
 * warning and leaves every schedule untouched.
 */

/** Due reminders read per query. */
export const BATCH_SIZE = 50;
/** Hard cap per tick, so one tick stays well inside the Worker's CPU budget. */
export const MAX_PER_TICK = 500;
/** Pushes in flight at once. */
export const CONCURRENCY = 6;
/** Consecutive failures after which a device's subscription is dropped. */
export const MAX_DEVICE_FAILURES = 5;
/** Delivery attempts per occurrence before giving up on it (first try + retries). */
export const MAX_ATTEMPTS = 3;
/** Wait between retries of an occurrence that reached no device. */
export const RETRY_DELAY_MS = 15 * 60 * 1000;
/** An occurrence this far overdue (e.g. while VAPID was unset) is skipped, not sent late. */
export const MAX_LATENESS_MS = 6 * 60 * 60 * 1000;

export interface DeliveryTotals {
  due: number;
  sent: number;
  expired: number;
  failed: number;
  dropped: number;
  retried: number;
  quiet: number;
  stale: number;
  noDevices: number;
}

interface ScheduleRow {
  id: string;
  app_id: string;
  user_id: string;
  next_at: number;
  occurrence_at: number;
  rule: string;
  tz: string;
  quiet_start: number | null;
  quiet_end: number | null;
  attempts: number;
}

interface SubscriptionRow {
  id: string;
  endpoint: string;
  failure_count: number;
}

export interface DeliveryDeps {
  now?: number;
  send?: (
    sub: PushSubscription,
    pub: string,
    priv: string,
    authorization?: string,
  ) => Promise<WebPushResult>;
  log?: (line: string) => void;
  warn?: (line: string) => void;
}

export async function runPushDelivery(env: Env, deps: DeliveryDeps = {}): Promise<DeliveryTotals> {
  const now = deps.now ?? Date.now();
  const send = deps.send ?? sendWebPush;
  const log = deps.log ?? ((line: string) => console.log(line));
  const warn = deps.warn ?? ((line: string) => console.warn(line));
  const totals: DeliveryTotals = {
    due: 0,
    sent: 0,
    expired: 0,
    failed: 0,
    dropped: 0,
    retried: 0,
    quiet: 0,
    stale: 0,
    noDevices: 0,
  };

  const pub = env.VAPID_PUBLIC_KEY;
  const priv = env.VAPID_PRIVATE_KEY;
  if (!pub || !priv) {
    const row = await env.DB.prepare('SELECT COUNT(*) AS n FROM push_schedules WHERE next_at <= ?')
      .bind(now)
      .first<{ n: number }>();
    totals.due = row?.n ?? 0;
    warn(`push: VAPID keys not set; skipping delivery (due=${totals.due})`);
    return totals;
  }

  // One signed JWT per push service per tick; signing is the costly part.
  const authCache = new Map<string, Promise<string>>();
  const authFor = (endpoint: string) => {
    const audience = pushAudience(endpoint);
    let auth = authCache.get(audience);
    if (!auth) {
      auth = vapidAuthorization(audience, pub, priv);
      authCache.set(audience, auth);
    }
    return auth;
  };

  while (totals.due < MAX_PER_TICK) {
    const { results } = await env.DB.prepare(
      `SELECT id, app_id, user_id, next_at, occurrence_at, rule, tz, quiet_start, quiet_end, attempts
       FROM push_schedules WHERE next_at <= ? ORDER BY next_at LIMIT ?`,
    )
      .bind(now, Math.min(BATCH_SIZE, MAX_PER_TICK - totals.due))
      .all<ScheduleRow>();
    const due = results ?? [];
    if (due.length === 0) break;
    totals.due += due.length;
    await mapLimit(due, CONCURRENCY, (s) =>
      deliverOne(env, s, now, totals, send, pub, priv, authFor),
    );
  }

  log(
    `push: due=${totals.due} sent=${totals.sent} expired=${totals.expired} failed=${totals.failed} ` +
      `dropped=${totals.dropped} retried=${totals.retried} quiet=${totals.quiet} stale=${totals.stale} ` +
      `no_devices=${totals.noDevices}`,
  );
  return totals;
}

async function deliverOne(
  env: Env,
  s: ScheduleRow,
  now: number,
  totals: DeliveryTotals,
  send: NonNullable<DeliveryDeps['send']>,
  pub: string,
  priv: string,
  authFor: (endpoint: string) => Promise<string>,
): Promise<void> {
  let rule: PushRule;
  try {
    rule = JSON.parse(s.rule) as PushRule;
  } catch {
    // Unreadable rule: nothing sensible to send or reschedule.
    await env.DB.prepare('DELETE FROM push_schedules WHERE id = ?').bind(s.id).run();
    return;
  }

  if (now - s.next_at > MAX_LATENESS_MS) {
    totals.stale++;
    await finish(env, s, rule, now);
    return;
  }

  if (
    s.quiet_start !== null &&
    s.quiet_end !== null &&
    inQuietHours(now, s.tz, s.quiet_start, s.quiet_end)
  ) {
    totals.quiet++;
    await env.DB.prepare('UPDATE push_schedules SET next_at = ? WHERE id = ?')
      .bind(quietHoursEnd(now, s.tz, s.quiet_end), s.id)
      .run();
    return;
  }

  const { results } = await env.DB.prepare(
    'SELECT id, endpoint, failure_count FROM push_subscriptions WHERE app_id = ? AND user_id = ?',
  )
    .bind(s.app_id, s.user_id)
    .all<SubscriptionRow>();
  const subs = results ?? [];
  if (subs.length === 0) {
    totals.noDevices++;
    await finish(env, s, rule, now);
    return;
  }

  let delivered = 0;
  let transient = 0;
  for (const sub of subs) {
    const result = await send({ endpoint: sub.endpoint }, pub, priv, await authFor(sub.endpoint));
    if (result.ok) {
      delivered++;
      totals.sent++;
      await env.DB.prepare(
        'UPDATE push_subscriptions SET last_success_at = ?, failure_count = 0 WHERE id = ?',
      )
        .bind(now, sub.id)
        .run();
    } else if (result.status === 404 || result.status === 410) {
      totals.expired++;
      await env.DB.prepare('DELETE FROM push_subscriptions WHERE id = ?').bind(sub.id).run();
    } else {
      totals.failed++;
      transient++;
      if (sub.failure_count + 1 >= MAX_DEVICE_FAILURES) {
        totals.dropped++;
        await env.DB.prepare('DELETE FROM push_subscriptions WHERE id = ?').bind(sub.id).run();
      } else {
        await env.DB.prepare(
          'UPDATE push_subscriptions SET failure_count = failure_count + 1 WHERE id = ?',
        )
          .bind(sub.id)
          .run();
      }
    }
  }

  if (delivered === 0 && transient > 0 && s.attempts + 1 < MAX_ATTEMPTS) {
    totals.retried++;
    await env.DB.prepare(
      'UPDATE push_schedules SET next_at = ?, attempts = attempts + 1 WHERE id = ?',
    )
      .bind(now + RETRY_DELAY_MS, s.id)
      .run();
    return;
  }
  await finish(env, s, rule, now);
}

/**
 * Done with this occurrence: delete a one-shot, or move a repeat to its next
 * occurrence. Advances from occurrence_at, not next_at, so a quiet-hours hold
 * or a retry never shifts the reminder off its own day.
 */
async function finish(env: Env, s: ScheduleRow, rule: PushRule, now: number): Promise<void> {
  const next = nextOccurrence(rule, s.tz, s.occurrence_at, now);
  if (next === null) {
    await env.DB.prepare('DELETE FROM push_schedules WHERE id = ?').bind(s.id).run();
    return;
  }
  await env.DB.prepare(
    'UPDATE push_schedules SET next_at = ?, occurrence_at = ?, attempts = 0 WHERE id = ?',
  )
    .bind(next, next, s.id)
    .run();
}

/** Runs fn over items with at most `limit` in flight; one item's failure doesn't stop the rest. */
async function mapLimit<T>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<void>,
): Promise<void> {
  let index = 0;
  const worker = async () => {
    while (index < items.length) {
      const item = items[index++] as T;
      try {
        await fn(item);
      } catch (err) {
        console.error('push: delivery error', err);
      }
    }
  };
  await Promise.allSettled(Array.from({ length: Math.min(limit, items.length) }, worker));
}
