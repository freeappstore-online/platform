import { describe, expect, it } from 'vitest';
import { app } from '../index.js';
import { PUSH_LIMITS } from '../lib/quota.js';
import { signSession } from '../lib/session.js';
import { hasSqlite, sqliteD1 } from '../lib/sqlite-d1.testutil.js';
import type { Env } from '../types.js';
import { isAllowedPushEndpoint } from './push.js';

const SIGNING_KEY = 'a'.repeat(64);

// The push routes run against real SQLite with every migration applied
// (lib/sqlite-d1.testutil.ts), so the upserts' ON CONFLICT / RETURNING and the
// per-app scoping run as written.

/** Two users and two apps; push tests run against this. */
function seeded() {
  const { db, d1 } = sqliteD1();
  const now = Date.now();
  const user = db.prepare(
    'INSERT INTO users (id, github_id, github_login, avatar_url, created_at) VALUES (?, ?, ?, NULL, ?)',
  );
  user.run('gh:1', 1, 'alice', now);
  user.run('gh:2', 2, 'bob', now);
  const appRow = db.prepare('INSERT INTO apps (id, owner_login, created_at) VALUES (?, ?, ?)');
  appRow.run('cycle', 'alice', now);
  appRow.run('notes', 'alice', now);
  return { db, d1 };
}

const env = (d1: D1Database, extra: Partial<Env> = {}): Env => ({
  DB: d1,
  ROOM: {} as DurableObjectNamespace,
  GITHUB_CLIENT_ID: 'cid',
  GITHUB_CLIENT_SECRET: 'csec',
  SESSION_SIGNING_KEY: SIGNING_KEY,
  ...extra,
});

const b64url = (bytes: Uint8Array) =>
  btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
const randomBytes = (n: number) => crypto.getRandomValues(new Uint8Array(n));
const p256dh = () => b64url(new Uint8Array([0x04, ...randomBytes(64)]));
const authKey = () => b64url(randomBytes(16));
const endpointN = (n: number) => `https://fcm.googleapis.com/fcm/send/device-${n}`;
const sub = (endpoint = endpointN(1)) => ({
  endpoint,
  keys: { p256dh: p256dh(), auth: authKey() },
});

async function call(
  e: Env,
  method: string,
  path: string,
  opts: {
    uid?: string | null;
    body?: unknown;
    raw?: string;
    headers?: Record<string, string>;
  } = {},
) {
  const headers: Record<string, string> = { 'Content-Type': 'application/json', ...opts.headers };
  if (opts.uid !== null)
    headers.Authorization = `Bearer ${await signSession(opts.uid ?? 'gh:1', SIGNING_KEY)}`;
  const body =
    method === 'GET'
      ? undefined
      : (opts.raw ?? (opts.body === undefined ? undefined : JSON.stringify(opts.body)));
  return app.request(
    `/v1${path}`,
    body === undefined ? { method, headers } : { method, headers, body },
    e,
  );
}

const rows = (db: ReturnType<typeof seeded>['db']) =>
  db
    .prepare(
      'SELECT app_id, user_id, endpoint, p256dh, failure_count FROM push_subscriptions ORDER BY endpoint',
    )
    .all() as Array<{
    app_id: string;
    user_id: string;
    endpoint: string;
    p256dh: string;
    failure_count: number;
  }>;

describe('GET /v1/push/vapid-public-key', () => {
  it('returns the public key when VAPID_PUBLIC_KEY is set (no auth needed)', async () => {
    const { d1 } = seeded();
    const res = await call(
      env(d1, { VAPID_PUBLIC_KEY: 'BPublicKey' }),
      'GET',
      '/push/vapid-public-key',
      { uid: null },
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ publicKey: 'BPublicKey' });
  });

  it('returns a clear 503 while VAPID_PUBLIC_KEY is not set', async () => {
    const { d1 } = seeded();
    const res = await call(env(d1), 'GET', '/push/vapid-public-key', { uid: null });
    expect(res.status).toBe(503);
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(await res.json()).toEqual({
      error: 'push is not configured: VAPID_PUBLIC_KEY is not set',
    });
  });
});

describe.skipIf(!hasSqlite)('push subscriptions (#145)', () => {
  const path = (appId = 'cycle') => `/apps/${appId}/push/subscriptions`;

  describe('auth and app scoping', () => {
    it('returns 401 without a session on every subscription route', async () => {
      const { d1 } = seeded();
      for (const method of ['GET', 'POST', 'DELETE']) {
        const res = await call(env(d1), method, path(), { uid: null, body: sub() });
        expect(res.status, method).toBe(401);
      }
    });

    it('returns 401 for a token signed with the wrong key', async () => {
      const { d1 } = seeded();
      const token = await signSession('gh:1', `wrong-key-${'x'.repeat(50)}`);
      const res = await call(env(d1), 'GET', path(), {
        uid: null,
        headers: { Authorization: `Bearer ${token}` },
      });
      expect(res.status).toBe(401);
    });

    it('returns 404 for an unknown app', async () => {
      const { d1, db } = seeded();
      for (const method of ['GET', 'POST', 'DELETE']) {
        const res = await call(env(d1), method, path('nope'), { body: sub() });
        expect(res.status, method).toBe(404);
      }
      expect(rows(db)).toHaveLength(0);
    });

    it("keeps apps and users apart: app A can't see or delete app B's subscriptions", async () => {
      const { d1 } = seeded();
      const e = env(d1);
      await call(e, 'POST', path('cycle'), { body: sub(endpointN(1)) });
      await call(e, 'POST', path('notes'), { body: sub(endpointN(2)) });
      await call(e, 'POST', path('cycle'), { uid: 'gh:2', body: sub(endpointN(3)) });

      const list = async (appId: string, uid: string) =>
        (
          (await (await call(e, 'GET', path(appId), { uid })).json()) as {
            subscriptions: Array<{ endpoint: string }>;
          }
        ).subscriptions.map((s) => s.endpoint);
      expect(await list('cycle', 'gh:1')).toEqual([endpointN(1)]);
      expect(await list('notes', 'gh:1')).toEqual([endpointN(2)]);
      expect(await list('cycle', 'gh:2')).toEqual([endpointN(3)]);

      // Deleting through the wrong app or as the wrong user finds nothing.
      expect(
        (await call(e, 'DELETE', path('notes'), { body: { endpoint: endpointN(1) } })).status,
      ).toBe(404);
      expect(
        (await call(e, 'DELETE', path('cycle'), { uid: 'gh:2', body: { endpoint: endpointN(1) } }))
          .status,
      ).toBe(404);
      expect(await list('cycle', 'gh:1')).toEqual([endpointN(1)]);
    });
  });

  describe('POST', () => {
    it('stores a new subscription with the user agent and returns 201', async () => {
      const { d1, db } = seeded();
      const body = sub();
      const res = await call(env(d1), 'POST', path(), {
        body,
        headers: { 'User-Agent': 'TestBrowser/1.0' },
      });
      expect(res.status).toBe(201);
      const json = (await res.json()) as { id: string; endpoint: string; createdAt: number };
      expect(json.endpoint).toBe(body.endpoint);
      expect(json.id).toMatch(/^[0-9a-f-]{36}$/);
      const stored = db.prepare('SELECT * FROM push_subscriptions').all() as Array<
        Record<string, unknown>
      >;
      expect(stored).toHaveLength(1);
      expect(stored[0]).toMatchObject({
        app_id: 'cycle',
        user_id: 'gh:1',
        endpoint: body.endpoint,
        p256dh: body.keys.p256dh,
        auth: body.keys.auth,
        user_agent: 'TestBrowser/1.0',
        failure_count: 0,
      });
    });

    it('upserts by endpoint: re-subscribing the same device updates its keys (200, same id)', async () => {
      const { d1, db } = seeded();
      const e = env(d1);
      const first = (await (await call(e, 'POST', path(), { body: sub() })).json()) as {
        id: string;
      };
      db.prepare('UPDATE push_subscriptions SET failure_count = 3').run();
      const again = sub();
      const res = await call(e, 'POST', path(), { body: again });
      expect(res.status).toBe(200);
      expect(((await res.json()) as { id: string }).id).toBe(first.id);
      expect(rows(db)).toEqual([
        {
          app_id: 'cycle',
          user_id: 'gh:1',
          endpoint: again.endpoint,
          p256dh: again.keys.p256dh,
          failure_count: 0,
        },
      ]);
    });

    it('moves an endpoint registered to another user to the current one', async () => {
      const { d1, db } = seeded();
      const e = env(d1);
      await call(e, 'POST', path(), { uid: 'gh:2', body: sub() });
      const res = await call(e, 'POST', path(), { uid: 'gh:1', body: sub() });
      expect(res.status).toBe(201);
      expect(rows(db).map((r) => [r.app_id, r.user_id])).toEqual([['cycle', 'gh:1']]);
    });

    it(`allows ${PUSH_LIMITS.maxSubscriptionsPerUser} devices per user per app, then 413`, async () => {
      const { d1, db } = seeded();
      const e = env(d1);
      for (let i = 0; i < PUSH_LIMITS.maxSubscriptionsPerUser; i++) {
        expect((await call(e, 'POST', path(), { body: sub(endpointN(i)) })).status).toBe(201);
      }
      const over = await call(e, 'POST', path(), { body: sub(endpointN(99)) });
      expect(over.status).toBe(413);
      expect(((await over.json()) as { error: string }).error).toContain('limit');
      // Refreshing an existing device still works at the cap, and other apps have their own budget.
      expect((await call(e, 'POST', path(), { body: sub(endpointN(0)) })).status).toBe(200);
      expect((await call(e, 'POST', path('notes'), { body: sub(endpointN(99)) })).status).toBe(201);
      expect(rows(db)).toHaveLength(PUSH_LIMITS.maxSubscriptionsPerUser + 1);
    });

    it.each([
      ['an http endpoint', { ...sub(), endpoint: 'http://fcm.googleapis.com/fcm/send/x' }],
      ['an endpoint on an unlisted host', { ...sub(), endpoint: 'https://evil.example.com/push' }],
      ['a look-alike host', { ...sub(), endpoint: 'https://fcm.googleapis.com.evil.example/x' }],
      [
        'an endpoint with credentials',
        { ...sub(), endpoint: 'https://user:pw@fcm.googleapis.com/x' },
      ],
      ['a non-default port', { ...sub(), endpoint: 'https://fcm.googleapis.com:8443/x' }],
      ['a missing endpoint', { keys: sub().keys }],
      [
        'a p256dh of the wrong length',
        { ...sub(), keys: { p256dh: b64url(new Uint8Array([4, 1, 2])), auth: authKey() } },
      ],
      [
        'a p256dh that is not uncompressed (no 0x04)',
        {
          ...sub(),
          keys: { p256dh: b64url(new Uint8Array([0x02, ...randomBytes(64)])), auth: authKey() },
        },
      ],
      [
        'a p256dh that is not base64url',
        { ...sub(), keys: { p256dh: '!!!not base64!!!', auth: authKey() } },
      ],
      [
        'an auth secret of the wrong length',
        { ...sub(), keys: { p256dh: p256dh(), auth: b64url(randomBytes(8)) } },
      ],
      ['missing keys', { endpoint: endpointN(1) }],
    ])('rejects %s with 400', async (_name, body) => {
      const { d1, db } = seeded();
      const res = await call(env(d1), 'POST', path(), { body });
      expect(res.status).toBe(400);
      expect(rows(db)).toHaveLength(0);
    });

    it('rejects a body that is not JSON (400) or not an object (400)', async () => {
      const { d1 } = seeded();
      expect((await call(env(d1), 'POST', path(), { raw: '{not json' })).status).toBe(400);
      expect((await call(env(d1), 'POST', path(), { raw: '[1,2]' })).status).toBe(400);
    });

    it(`rejects a body over ${PUSH_LIMITS.maxBodyBytes} bytes with 413`, async () => {
      const { d1, db } = seeded();
      const body = { ...sub(), padding: 'x'.repeat(PUSH_LIMITS.maxBodyBytes) };
      const res = await call(env(d1), 'POST', path(), { body });
      expect(res.status).toBe(413);
      expect(rows(db)).toHaveLength(0);
    });

    it('accepts endpoints from each supported push service', () => {
      for (const ok of [
        'https://fcm.googleapis.com/fcm/send/abc',
        'https://updates.push.services.mozilla.com/wpush/v2/abc',
        'https://wns2-par02p.notify.windows.com/w/?token=abc',
        'https://web.push.apple.com/QGhk',
      ]) {
        expect(isAllowedPushEndpoint(ok), ok).toBe(true);
      }
      expect(
        isAllowedPushEndpoint(
          `https://fcm.googleapis.com/${'x'.repeat(PUSH_LIMITS.maxEndpointLength)}`,
        ),
      ).toBe(false);
    });
  });

  describe('DELETE', () => {
    it('removes the device (204), then 404 when it is already gone', async () => {
      const { d1, db } = seeded();
      const e = env(d1);
      const body = sub();
      await call(e, 'POST', path(), { body });
      expect((await call(e, 'DELETE', path(), { body: { endpoint: body.endpoint } })).status).toBe(
        204,
      );
      expect(rows(db)).toHaveLength(0);
      expect((await call(e, 'DELETE', path(), { body: { endpoint: body.endpoint } })).status).toBe(
        404,
      );
    });

    it('requires an endpoint (400)', async () => {
      const { d1 } = seeded();
      expect((await call(env(d1), 'DELETE', path(), { body: {} })).status).toBe(400);
    });
  });

  describe('GET', () => {
    it("lists this user's devices for this app without their keys", async () => {
      const { d1 } = seeded();
      const e = env(d1);
      await call(e, 'POST', path(), {
        body: sub(endpointN(1)),
        headers: { 'User-Agent': 'Phone' },
      });
      const res = await call(e, 'GET', path());
      expect(res.status).toBe(200);
      const { subscriptions } = (await res.json()) as {
        subscriptions: Array<Record<string, unknown>>;
      };
      expect(subscriptions).toHaveLength(1);
      expect(subscriptions[0]).toMatchObject({
        endpoint: endpointN(1),
        userAgent: 'Phone',
        failureCount: 0,
        lastSuccessAt: null,
      });
      expect(subscriptions[0]).not.toHaveProperty('p256dh');
      expect(subscriptions[0]).not.toHaveProperty('auth');
    });

    it('returns an empty list when the user has no devices', async () => {
      const { d1 } = seeded();
      const res = await call(env(d1), 'GET', path());
      expect(await res.json()).toEqual({ subscriptions: [] });
    });
  });
});

describe.skipIf(!hasSqlite)('push reminder schedules (#146)', () => {
  const path = (reminderId = 'period', appId = 'cycle') =>
    `/apps/${appId}/push/schedules/${reminderId}`;
  const daily = { rule: { type: 'daily', time: '09:00' }, tz: 'Europe/London' };
  type Sched = {
    reminderId: string;
    nextAt: number;
    tz: string;
    quietHours: unknown;
    rule: unknown;
  };

  it('returns 401 without a session and 404 for an unknown app', async () => {
    const { d1 } = seeded();
    for (const method of ['GET', 'PUT', 'DELETE']) {
      const p = method === 'GET' ? '/apps/cycle/push/schedules' : path();
      expect((await call(env(d1), method, p, { uid: null, body: daily })).status, method).toBe(401);
      const unknown = method === 'GET' ? '/apps/nope/push/schedules' : path('period', 'nope');
      expect((await call(env(d1), method, unknown, { body: daily })).status, method).toBe(404);
    }
  });

  it('creates a schedule (201) with its first occurrence in the time zone, then replaces it (200)', async () => {
    const { d1, db } = seeded();
    const e = env(d1);
    const created = await call(e, 'PUT', path(), {
      body: { ...daily, quietHours: { start: '22:00', end: '07:00' } },
    });
    expect(created.status).toBe(201);
    const s = (await created.json()) as Sched;
    expect(s).toMatchObject({
      reminderId: 'period',
      tz: 'Europe/London',
      rule: { type: 'daily', time: '09:00' },
      quietHours: { start: '22:00', end: '07:00' },
    });
    expect(s.nextAt).toBeGreaterThan(Date.now());
    const local = new Intl.DateTimeFormat('en-GB', {
      timeZone: 'Europe/London',
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    }).format(new Date(s.nextAt));
    expect(local).toBe('09:00');

    const replaced = await call(e, 'PUT', path(), {
      body: { rule: { type: 'every', days: 2, time: '20:30' }, tz: 'UTC' },
    });
    expect(replaced.status).toBe(200);
    expect(((await replaced.json()) as Sched).quietHours).toBeNull();
    const stored = db
      .prepare(
        'SELECT COUNT(*) AS n, MAX(next_at) AS next, MAX(occurrence_at) AS occ FROM push_schedules',
      )
      .get() as {
      n: number;
      next: number;
      occ: number;
    };
    expect(stored.n).toBe(1);
    expect(stored.occ).toBe(stored.next);
  });

  it('accepts a one-shot with an ISO time and stores it as that instant', async () => {
    const { d1 } = seeded();
    const at = new Date(Date.now() + 3_600_000).toISOString();
    const res = await call(env(d1), 'PUT', path('pill'), {
      body: { rule: { type: 'at', at }, tz: 'UTC' },
    });
    expect(res.status).toBe(201);
    expect(((await res.json()) as Sched).nextAt).toBe(Date.parse(at));
  });

  it.each([
    ['a bad time zone', { ...daily, tz: 'Nowhere/City' }],
    ['a missing time zone', { rule: daily.rule }],
    ['a bad rule', { ...daily, rule: { type: 'hourly' } }],
    ['a past one-shot', { rule: { type: 'at', at: Date.now() - 1000 }, tz: 'UTC' }],
    ['bad quiet hours', { ...daily, quietHours: { start: '10pm', end: '07:00' } }],
  ])('rejects %s with 400', async (_name, body) => {
    const { d1, db } = seeded();
    expect((await call(env(d1), 'PUT', path(), { body })).status).toBe(400);
    expect(db.prepare('SELECT COUNT(*) AS n FROM push_schedules').get()).toEqual({ n: 0 });
  });

  it('rejects a bad reminder id with 400', async () => {
    const { d1 } = seeded();
    expect((await call(env(d1), 'PUT', path('has space'), { body: daily })).status).toBe(400);
    expect((await call(env(d1), 'PUT', path('x'.repeat(65)), { body: daily })).status).toBe(400);
  });

  it(`allows ${PUSH_LIMITS.maxSchedulesPerUser} reminders per user per app, then 413`, async () => {
    const { d1 } = seeded();
    const e = env(d1);
    for (let i = 0; i < PUSH_LIMITS.maxSchedulesPerUser; i++) {
      expect((await call(e, 'PUT', path(`r${i}`), { body: daily })).status).toBe(201);
    }
    expect((await call(e, 'PUT', path('one-too-many'), { body: daily })).status).toBe(413);
    expect((await call(e, 'PUT', path('r0'), { body: daily })).status).toBe(200); // replacing still works
    expect((await call(e, 'PUT', path('r0', 'notes'), { body: daily })).status).toBe(201); // per app
  });

  it("lists and deletes only this user's reminders for this app", async () => {
    const { d1 } = seeded();
    const e = env(d1);
    await call(e, 'PUT', path('mine'), { body: daily });
    await call(e, 'PUT', path('other-app', 'notes'), { body: daily });
    await call(e, 'PUT', path('bobs'), { uid: 'gh:2', body: daily });

    const list = (await (await call(e, 'GET', '/apps/cycle/push/schedules')).json()) as {
      schedules: Sched[];
    };
    expect(list.schedules.map((s) => s.reminderId)).toEqual(['mine']);

    expect((await call(e, 'DELETE', path('bobs'))).status).toBe(404);
    expect((await call(e, 'DELETE', path('other-app'))).status).toBe(404);
    expect((await call(e, 'DELETE', path('mine'))).status).toBe(204);
    expect((await call(e, 'DELETE', path('mine'))).status).toBe(404);
  });
});
