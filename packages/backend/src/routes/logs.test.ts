import { describe, expect, it } from 'vitest';
import { app } from '../index.js';
import { dayKey } from '../lib/proxy-rate-limit.js';
import { signSession } from '../lib/session.js';
import { hasSqlite, sqliteD1 } from '../lib/sqlite-d1.testutil.js';
import { DAILY_LOG_ROWS_PER_USER } from './logs.js';

const SIGNING_KEY = 'a'.repeat(64);

function fakeDB(
  user: Record<string, unknown> | null,
  opts: {
    logs?: Array<Record<string, unknown>>;
    build?: Record<string, unknown> | null;
    binds?: Array<{ sql: string; args: unknown[] }>;
  } = {},
) {
  return {
    prepare: (sql: string) => ({
      bind: (...args: unknown[]) => {
        opts.binds?.push({ sql, args });
        return {
          first: async () => {
            if (sql.includes('FROM users')) return user;
            if (sql.includes('FROM apps'))
              return user ? { owner_login: (user as Record<string, unknown>).github_login } : null;
            if (sql.includes('FROM app_logs') && sql.includes('build_meta IS NOT NULL'))
              return opts.build ?? { build_meta: '{"sdkVersion":"0.12.0"}', ts: 1000 };
            return null;
          },
          all: async () => ({ results: opts.logs ?? [] }),
          run: async () => ({ meta: { changes: 1 } }),
        };
      },
    }),
    batch: async () => {},
  } as unknown as D1Database;
}

function env(db: D1Database) {
  return { DB: db, SESSION_SIGNING_KEY: SIGNING_KEY };
}

async function authHeader(userId = 'u1') {
  const token = await signSession(userId, SIGNING_KEY);
  return `Bearer ${token}`;
}

describe('logs routes', () => {
  const user = { id: 'u1', github_login: 'test', avatar_url: null, date_of_birth: null };

  it('POST /v1/apps/:appId/logs returns 401 without auth', async () => {
    const res = await app.request('/v1/apps/timer/logs', { method: 'POST' }, env(fakeDB(null)));
    expect(res.status).toBe(401);
  });

  it('POST /v1/apps/:appId/logs returns 400 for missing entries', async () => {
    const res = await app.request(
      '/v1/apps/timer/logs',
      {
        method: 'POST',
        headers: { Authorization: await authHeader(), 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      },
      env(fakeDB(user)),
    );
    expect(res.status).toBe(400);
  });

  it('POST /v1/apps/:appId/logs ingests valid entries', async () => {
    const res = await app.request(
      '/v1/apps/timer/logs',
      {
        method: 'POST',
        headers: { Authorization: await authHeader(), 'Content-Type': 'application/json' },
        body: JSON.stringify({
          entries: [
            { ts: Date.now(), level: 'info', category: 'app', message: 'test' },
            {
              ts: Date.now(),
              level: 'error',
              category: 'sdk',
              message: 'oops',
              data: { code: 500 },
            },
          ],
        }),
      },
      env(fakeDB(user)),
    );
    expect(res.status).toBe(200);
    const data = (await res.json()) as { ok: boolean; ingested: number };
    expect(data.ok).toBe(true);
    expect(data.ingested).toBe(2);
  });

  it('GET /v1/apps/:appId/logs returns 401 without auth', async () => {
    const res = await app.request('/v1/apps/timer/logs', {}, env(fakeDB(null)));
    expect(res.status).toBe(401);
  });

  it('GET /v1/apps/:appId/logs does not bind NaN for a bad limit or since', async () => {
    const binds: Array<{ sql: string; args: unknown[] }> = [];
    const res = await app.request(
      '/v1/apps/timer/logs?limit=abc&since=nope',
      { headers: { Authorization: await authHeader() } },
      env(fakeDB(user, { binds })),
    );
    expect(res.status).toBe(200);
    const list = binds.find((b) => b.sql.includes('ORDER BY ts DESC'));
    expect(list?.args).toEqual(['timer', 100]);
  });

  it('GET /v1/apps/:appId/logs keeps a numeric since and caps the page size', async () => {
    const binds: Array<{ sql: string; args: unknown[] }> = [];
    const res = await app.request(
      '/v1/apps/timer/logs?limit=9999&since=50',
      { headers: { Authorization: await authHeader() } },
      env(fakeDB(user, { binds })),
    );
    expect(res.status).toBe(200);
    const list = binds.find((b) => b.sql.includes('ORDER BY ts DESC'));
    expect(list?.args).toEqual(['timer', 50, 500]);
  });

  it('GET /v1/apps/:appId/logs returns logs list', async () => {
    const res = await app.request(
      '/v1/apps/timer/logs',
      {
        headers: { Authorization: await authHeader() },
      },
      env(fakeDB(user)),
    );
    expect(res.status).toBe(200);
    const data = (await res.json()) as { logs: unknown[] };
    expect(Array.isArray(data.logs)).toBe(true);
  });

  it('GET /v1/apps/:appId/logs tolerates malformed JSON fields', async () => {
    const logs = [
      {
        ts: 1000,
        level: 'error',
        category: 'app',
        message: 'bad row',
        data: '{bad',
        build_meta: '{bad',
        user_id: 'u1',
      },
    ];
    const res = await app.request(
      '/v1/apps/timer/logs',
      {
        headers: { Authorization: await authHeader() },
      },
      env(fakeDB(user, { logs })),
    );
    expect(res.status).toBe(200);
    const data = (await res.json()) as { logs: Array<{ data?: unknown; build?: unknown }> };
    expect(data.logs).toHaveLength(1);
    expect(data.logs[0]!.data).toBeUndefined();
    expect(data.logs[0]!.build).toBeUndefined();
  });

  it('GET /v1/apps/:appId/logs/build returns build metadata', async () => {
    const res = await app.request(
      '/v1/apps/timer/logs/build',
      {
        headers: { Authorization: await authHeader() },
      },
      env(fakeDB(user)),
    );
    expect(res.status).toBe(200);
    const data = (await res.json()) as { build: Record<string, unknown>; ts: number };
    expect(data.build.sdkVersion).toBe('0.12.0');
  });

  it('GET /v1/apps/:appId/logs/build tolerates malformed build metadata', async () => {
    const res = await app.request(
      '/v1/apps/timer/logs/build',
      {
        headers: { Authorization: await authHeader() },
      },
      env(fakeDB(user, { build: { build_meta: '{bad', ts: 1000 } })),
    );
    expect(res.status).toBe(200);
    const data = (await res.json()) as { build: unknown; ts: number };
    expect(data.build).toBeNull();
    expect(data.ts).toBe(1000);
  });
});

describe.skipIf(!hasSqlite)('log ingest bounds against real SQLite (#490)', () => {
  function setup() {
    const { db, d1 } = sqliteD1();
    const now = Date.now();
    db.prepare(
      'INSERT INTO users (id, github_id, github_login, avatar_url, created_at) VALUES (?, ?, ?, NULL, ?)',
    ).run('u1', 1, 'alice', now);
    db.prepare('INSERT INTO apps (id, owner_login, created_at) VALUES (?, ?, ?)').run(
      'timer',
      'owner',
      now,
    );
    const e = { DB: d1, SESSION_SIGNING_KEY: SIGNING_KEY };
    const post = async (appId: string, entries: unknown[]) =>
      app.request(
        `/v1/apps/${appId}/logs`,
        {
          method: 'POST',
          headers: { Authorization: await authHeader('u1'), 'Content-Type': 'application/json' },
          body: JSON.stringify({ entries }),
        },
        e,
      );
    const rows = () => (db.prepare('SELECT COUNT(*) AS n FROM app_logs').get() as { n: number }).n;
    return { db, post, rows };
  }
  const ok = (i = 0) => ({ ts: 1000 + i, level: 'info', category: 'app', message: `m${i}` });

  it('404s for an app that does not exist and stores nothing', async () => {
    const { post, rows } = setup();
    const res = await post('nope', [ok()]);
    expect(res.status).toBe(404);
    expect(rows()).toBe(0);
  });

  it('drops entries with a non-numeric ts, unknown level, non-string category or oversized build', async () => {
    const { db, post, rows } = setup();
    const res = await post('timer', [
      ok(),
      { ...ok(1), ts: '1000' },
      { ...ok(2), level: 'verbose' },
      { ...ok(3), category: { x: 1 } },
      { ...ok(4), build: { blob: 'x'.repeat(5000) } },
      { ...ok(5), build: { sdkVersion: '1.0.0' } },
    ]);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, ingested: 2 });
    expect(rows()).toBe(2);
    const stored = db.prepare('SELECT message FROM app_logs ORDER BY ts').all() as Array<{
      message: string;
    }>;
    expect(stored.map((r) => r.message)).toEqual(['m0', 'm5']);
  });

  it('caps rows per user per day, charging each row', async () => {
    const { db, post, rows } = setup();
    db.prepare('INSERT INTO app_proxy_usage (app_id, day, count) VALUES (?, ?, ?)').run(
      'logs-user:u1',
      dayKey(Date.now()),
      DAILY_LOG_ROWS_PER_USER - 1,
    );
    expect((await post('timer', [ok(0), ok(1)])).status).toBe(429);
    expect(rows()).toBe(0);
    expect((await post('timer', [ok(0)])).status).toBe(200);
    expect(rows()).toBe(1);
    expect((await post('timer', [ok(1)])).status).toBe(429);
    expect(rows()).toBe(1);
  });
});
