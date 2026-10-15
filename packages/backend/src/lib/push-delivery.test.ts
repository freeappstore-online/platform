import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { Env } from '../types.js';
import {
  BATCH_SIZE,
  MAX_ATTEMPTS,
  MAX_DEVICE_FAILURES,
  MAX_LATENESS_MS,
  RETRY_DELAY_MS,
  runPushDelivery,
} from './push-delivery.js';
import { zonedTime } from './push-schedule.js';
import { hasSqlite, type SqliteDb, sqliteD1 } from './sqlite-d1.testutil.js';

// The cron delivery runs against real SQLite (every migration applied) and
// the real Web Push sender; only fetch is mocked, answering per endpoint.

let VAPID_PUBLIC: string;
let VAPID_PRIVATE: string;
beforeAll(async () => {
  const kp = (await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, [
    'sign',
  ])) as CryptoKeyPair;
  const raw = new Uint8Array((await crypto.subtle.exportKey('raw', kp.publicKey)) as ArrayBuffer);
  VAPID_PUBLIC = btoa(String.fromCharCode(...raw))
    .replace(/=/g, '')
    .replace(/\+/g, '-')
    .replace(/\//g, '_');
  VAPID_PRIVATE = ((await crypto.subtle.exportKey('jwk', kp.privateKey)) as JsonWebKey).d as string;
});

const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
});

/** Mocks fetch; `statusFor` picks each endpoint's response (default 201). */
function mockPushService(statusFor: Record<string, number> = {}) {
  const fn = vi.fn(async (url: string) => ({ status: statusFor[url] ?? 201 }));
  globalThis.fetch = fn as unknown as typeof fetch;
  const endpoints = () => fn.mock.calls.map((c) => c[0] as string);
  const authHeaders = () =>
    fn.mock.calls.map(
      (c) =>
        (c as unknown as [string, { headers: Record<string, string> }])[1].headers.Authorization,
    );
  return { fn, endpoints, authHeaders };
}

const NOW = Date.UTC(2026, 5, 1, 12, 0); // 2026-06-01T12:00Z, 08:00 in New York
const NY = 'America/New_York';
const endpoint = (name: string) => `https://fcm.googleapis.com/fcm/send/${name}`;

function setup(withVapid = true) {
  const { db, d1 } = sqliteD1();
  const env = {
    DB: d1,
    ...(withVapid ? { VAPID_PUBLIC_KEY: VAPID_PUBLIC, VAPID_PRIVATE_KEY: VAPID_PRIVATE } : {}),
  } as unknown as Env;
  const lines: string[] = [];
  const warnings: string[] = [];
  const run = (now = NOW) =>
    runPushDelivery(env, { now, log: (l) => lines.push(l), warn: (l) => warnings.push(l) });
  return { db, env, run, lines, warnings };
}

let ids = 0;
function addSub(db: SqliteDb, appId: string, userId: string, name: string, failures = 0) {
  db.prepare(
    `INSERT INTO push_subscriptions (id, app_id, user_id, endpoint, p256dh, auth, created_at, failure_count)
     VALUES (?, ?, ?, ?, 'p', 'a', ?, ?)`,
  ).run(`sub-${++ids}`, appId, userId, endpoint(name), NOW - 86_400_000, failures);
}

function addSchedule(
  db: SqliteDb,
  opts: {
    appId?: string;
    userId?: string;
    reminderId?: string;
    nextAt: number;
    rule: unknown;
    tz?: string;
    quiet?: [number, number];
    attempts?: number;
  },
) {
  const id = `sched-${++ids}`;
  db.prepare(
    `INSERT INTO push_schedules
       (id, app_id, user_id, reminder_id, next_at, occurrence_at, rule, tz, quiet_start, quiet_end, attempts, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    opts.appId ?? 'cycle',
    opts.userId ?? 'gh:1',
    opts.reminderId ?? id,
    opts.nextAt,
    opts.nextAt,
    JSON.stringify(opts.rule),
    opts.tz ?? 'UTC',
    opts.quiet?.[0] ?? null,
    opts.quiet?.[1] ?? null,
    opts.attempts ?? 0,
    NOW - 86_400_000,
  );
  return id;
}

const schedule = (db: SqliteDb, id: string) =>
  db.prepare('SELECT next_at, attempts FROM push_schedules WHERE id = ?').get(id) as
    | { next_at: number; attempts: number }
    | undefined;
const sub = (db: SqliteDb, name: string) =>
  db
    .prepare('SELECT failure_count, last_success_at FROM push_subscriptions WHERE endpoint = ?')
    .get(endpoint(name)) as { failure_count: number; last_success_at: number | null } | undefined;
const daily = { type: 'daily', time: '12:00' };
const oneShot = { type: 'at', at: NOW - 60_000 };

describe.skipIf(!hasSqlite)('runPushDelivery (#146)', () => {
  it('skips with a logged warning, sending nothing and changing nothing, while VAPID is unset', async () => {
    const { db, run, warnings } = setup(false);
    const service = mockPushService();
    addSub(db, 'cycle', 'gh:1', 'phone');
    const id = addSchedule(db, { nextAt: NOW - 60_000, rule: oneShot });
    const totals = await run();
    expect(warnings).toEqual(['push: VAPID keys not set; skipping delivery (due=1)']);
    expect(totals.due).toBe(1);
    expect(service.fn).not.toHaveBeenCalled();
    expect(schedule(db, id)?.next_at).toBe(NOW - 60_000);
  });

  it('selects only due reminders and logs per-tick totals', async () => {
    const { db, run, lines } = setup();
    const service = mockPushService();
    addSub(db, 'cycle', 'gh:1', 'phone');
    const due = addSchedule(db, { nextAt: NOW, rule: oneShot });
    const later = addSchedule(db, { nextAt: NOW + 60_000, rule: { type: 'at', at: NOW + 60_000 } });
    await run();
    expect(service.endpoints()).toEqual([endpoint('phone')]);
    expect(schedule(db, due)).toBeUndefined();
    expect(schedule(db, later)?.next_at).toBe(NOW + 60_000);
    expect(lines).toEqual([
      'push: due=1 sent=1 expired=0 failed=0 dropped=0 retried=0 quiet=0 stale=0 no_devices=0',
    ]);
  });

  it("sends only to the user's devices for that app", async () => {
    const { db, run } = setup();
    const service = mockPushService();
    addSub(db, 'cycle', 'gh:1', 'alice-phone');
    addSub(db, 'cycle', 'gh:1', 'alice-laptop');
    addSub(db, 'notes', 'gh:1', 'alice-notes-app');
    addSub(db, 'cycle', 'gh:2', 'bob-phone');
    addSchedule(db, { appId: 'cycle', userId: 'gh:1', nextAt: NOW, rule: oneShot });
    await run();
    expect(service.endpoints().sort()).toEqual([endpoint('alice-laptop'), endpoint('alice-phone')]);
  });

  it('records a success and reuses one signed JWT per push service in a tick', async () => {
    const { db, run } = setup();
    const service = mockPushService();
    addSub(db, 'cycle', 'gh:1', 'phone', 2);
    addSub(db, 'cycle', 'gh:1', 'laptop');
    addSchedule(db, { nextAt: NOW, rule: oneShot });
    await run();
    expect(sub(db, 'phone')).toEqual({ failure_count: 0, last_success_at: NOW });
    const [a, b] = service.authHeaders();
    expect(a).toMatch(/^vapid t=.+, k=.+$/);
    expect(b).toBe(a);
  });

  it('deletes a one-shot after sending', async () => {
    const { db, run } = setup();
    mockPushService();
    addSub(db, 'cycle', 'gh:1', 'phone');
    const id = addSchedule(db, { nextAt: NOW, rule: oneShot });
    await run();
    expect(schedule(db, id)).toBeUndefined();
  });

  it('advances a daily reminder to the same local time across a DST change', async () => {
    const { db, run } = setup();
    const service = mockPushService();
    addSub(db, 'cycle', 'gh:1', 'phone');
    const sat = zonedTime({ year: 2026, month: 3, day: 7 }, 9 * 60, NY); // 09:00 EST = 14:00Z
    const id = addSchedule(db, { nextAt: sat, rule: { type: 'daily', time: '09:00' }, tz: NY });
    await run(sat + 5 * 60_000);
    expect(service.fn).toHaveBeenCalledOnce();
    expect(new Date(schedule(db, id)?.next_at as number).toISOString()).toBe(
      '2026-03-08T13:00:00.000Z',
    ); // 09:00 EDT
    expect(schedule(db, id)?.attempts).toBe(0);
  });

  it('holds a reminder that comes due in quiet hours until the window ends', async () => {
    const { db, run, lines } = setup();
    const service = mockPushService();
    addSub(db, 'cycle', 'gh:1', 'phone');
    const night = Date.UTC(2026, 5, 1, 23, 0);
    const id = addSchedule(db, {
      nextAt: night,
      rule: { type: 'daily', time: '23:00' },
      quiet: [22 * 60, 7 * 60],
    });
    await run(night);
    expect(service.fn).not.toHaveBeenCalled();
    expect(schedule(db, id)?.next_at).toBe(Date.UTC(2026, 5, 2, 7, 0));
    expect(lines[0]).toContain('quiet=1');
    // At 07:00 it goes out, then returns to its own 23:00 time.
    await run(Date.UTC(2026, 5, 2, 7, 0));
    expect(service.fn).toHaveBeenCalledOnce();
    expect(schedule(db, id)?.next_at).toBe(Date.UTC(2026, 5, 2, 23, 0));
  });

  it.each([410, 404])(
    'deletes a subscription the push service reports gone (%i)',
    async (status) => {
      const { db, run, lines } = setup();
      mockPushService({ [endpoint('old-phone')]: status });
      addSub(db, 'cycle', 'gh:1', 'old-phone');
      addSub(db, 'cycle', 'gh:1', 'phone');
      addSchedule(db, { nextAt: NOW, rule: oneShot });
      await run();
      expect(sub(db, 'old-phone')).toBeUndefined();
      expect(sub(db, 'phone')?.last_success_at).toBe(NOW);
      expect(lines[0]).toContain('sent=1 expired=1');
    },
  );

  it('counts a 500 as a failure and drops the device after repeated failures', async () => {
    const { db, run } = setup();
    mockPushService({ [endpoint('flaky')]: 500, [endpoint('dying')]: 500 });
    addSub(db, 'cycle', 'gh:1', 'phone');
    addSub(db, 'cycle', 'gh:1', 'flaky', 0);
    addSub(db, 'cycle', 'gh:1', 'dying', MAX_DEVICE_FAILURES - 1);
    const id = addSchedule(db, { nextAt: NOW, rule: daily });
    const totals = await run();
    expect(sub(db, 'flaky')?.failure_count).toBe(1);
    expect(sub(db, 'dying')).toBeUndefined();
    expect(totals).toMatchObject({ sent: 1, failed: 2, dropped: 1, retried: 0 });
    // One device got it, so the occurrence is done: no retry.
    expect(schedule(db, id)).toEqual({ next_at: NOW + 86_400_000, attempts: 0 });
  });

  it(`retries an occurrence that reached no device, up to ${MAX_ATTEMPTS} attempts, then moves on`, async () => {
    const { db, run } = setup();
    const service = mockPushService({ [endpoint('phone')]: 503 });
    addSub(db, 'cycle', 'gh:1', 'phone');
    const id = addSchedule(db, { nextAt: NOW, rule: daily });

    let t = NOW;
    for (let attempt = 1; attempt < MAX_ATTEMPTS; attempt++) {
      const totals = await run(t);
      expect(totals.retried).toBe(1);
      expect(schedule(db, id)).toEqual({ next_at: t + RETRY_DELAY_MS, attempts: attempt });
      t += RETRY_DELAY_MS;
    }
    const last = await run(t);
    expect(last.retried).toBe(0);
    expect(service.fn).toHaveBeenCalledTimes(MAX_ATTEMPTS);
    expect(schedule(db, id)).toEqual({ next_at: NOW + 86_400_000, attempts: 0 });
    expect(sub(db, 'phone')?.failure_count).toBe(MAX_ATTEMPTS);
  });

  it('treats a network error like a transient failure', async () => {
    const { db, run } = setup();
    globalThis.fetch = vi.fn(async () => {
      throw new TypeError('fetch failed');
    }) as unknown as typeof fetch;
    addSub(db, 'cycle', 'gh:1', 'phone');
    const id = addSchedule(db, { nextAt: NOW, rule: oneShot });
    const totals = await run();
    expect(totals).toMatchObject({ failed: 1, retried: 1 });
    expect(schedule(db, id)?.attempts).toBe(1);
  });

  it('skips an occurrence that is too overdue instead of sending it late', async () => {
    const { db, run } = setup();
    const service = mockPushService();
    addSub(db, 'cycle', 'gh:1', 'phone');
    const old = addSchedule(db, { nextAt: NOW - MAX_LATENESS_MS - 60_000, rule: daily });
    const gone = addSchedule(db, { nextAt: NOW - MAX_LATENESS_MS - 60_000, rule: oneShot });
    const totals = await run();
    expect(service.fn).not.toHaveBeenCalled();
    expect(totals.stale).toBe(2);
    expect(schedule(db, old)?.next_at).toBe(NOW + 86_400_000);
    expect(schedule(db, gone)).toBeUndefined();
  });

  it('moves on when the user has no devices for the app', async () => {
    const { db, run } = setup();
    const service = mockPushService();
    const id = addSchedule(db, { nextAt: NOW, rule: daily });
    const totals = await run();
    expect(service.fn).not.toHaveBeenCalled();
    expect(totals.noDevices).toBe(1);
    expect(schedule(db, id)?.next_at).toBe(NOW + 86_400_000);
  });

  it('works through more than one batch in a tick', async () => {
    const { db, run } = setup();
    const service = mockPushService();
    addSub(db, 'cycle', 'gh:1', 'phone');
    for (let i = 0; i < BATCH_SIZE + 10; i++) addSchedule(db, { nextAt: NOW - i, rule: oneShot });
    const totals = await run();
    expect(totals.due).toBe(BATCH_SIZE + 10);
    expect(service.fn).toHaveBeenCalledTimes(BATCH_SIZE + 10);
    expect(db.prepare('SELECT COUNT(*) AS n FROM push_schedules').get()).toEqual({ n: 0 });
  });
});
