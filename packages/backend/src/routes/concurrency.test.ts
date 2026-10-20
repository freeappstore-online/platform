import { describe, expect, it } from 'vitest';
import { app } from '../index.js';
import { dayKey } from '../lib/proxy-rate-limit.js';
import { signSession } from '../lib/session.js';
import { hasSqlite, type SqliteDb, sqliteD1, withBarrier } from '../lib/sqlite-d1.testutil.js';

/**
 * #277: caps and read-modify-write hold under concurrency. Each test makes
 * every request run the pre-check read before any of them writes (the
 * barrier), which is the race a sequential test never sees.
 */

const SIGNING_KEY = 'a'.repeat(64);

async function setup() {
  const { db, d1 } = sqliteD1();
  const now = Date.now();
  db.prepare(
    'INSERT INTO users (id, github_id, github_login, avatar_url, created_at) VALUES (?, ?, ?, NULL, ?)',
  ).run('gh:1', 1, 'alice', now);
  db.prepare('INSERT INTO apps (id, owner_login, created_at) VALUES (?, ?, ?)').run(
    'timer',
    'alice',
    now,
  );
  const auth = { Authorization: `Bearer ${await signSession('gh:1', SIGNING_KEY)}` };
  return { db, d1, auth, now };
}

/** Fire `n` requests that all reach `barrier` before any of them continues. */
async function race(
  d1: D1Database,
  barrier: RegExp,
  n: number,
  request: (i: number) => Request,
  extraEnv: Record<string, unknown> = {},
): Promise<number[]> {
  const env = { DB: withBarrier(d1, barrier, n), SESSION_SIGNING_KEY: SIGNING_KEY, ...extraEnv };
  return Promise.all(
    Array.from(
      { length: n },
      async (_, i) => (await app.request(request(i), undefined, env)).status,
    ),
  );
}

const count = (db: SqliteDb, sql: string) => (db.prepare(sql).get() as { n: number }).n;
const url = (path: string) => `http://localhost/v1/apps/timer${path}`;

describe.skipIf(!hasSqlite)('caps under concurrency (#277)', () => {
  it('counters: 20 parallel new keys at 999/1000, exactly one lands', async () => {
    const { db, d1, auth, now } = await setup();
    const ins = db.prepare(
      'INSERT INTO counters (app_id, key, value, updated_at) VALUES (?, ?, 1, ?)',
    );
    for (let i = 0; i < 999; i++) ins.run('timer', `c${i}`, now);
    const statuses = await race(
      d1,
      /SELECT COUNT\(\*\) AS cnt FROM counters/,
      20,
      (i) => new Request(url(`/counters/new${i}`), { method: 'POST', headers: auth }),
    );
    expect(statuses.filter((s) => s === 200)).toHaveLength(1);
    expect(count(db, "SELECT COUNT(*) AS n FROM counters WHERE app_id = 'timer'")).toBe(1000);
  });

  it('documents: 20 parallel creates at 9999/10000, exactly one lands', async () => {
    const { db, d1, auth, now } = await setup();
    const ins = db.prepare(
      "INSERT INTO documents (app_id, collection, id, data, owner_id, created_at, updated_at) VALUES ('timer', 'posts', ?, '{}', 'gh:1', ?, ?)",
    );
    for (let i = 0; i < 9999; i++) ins.run(`d${i}`, now, now);
    const statuses = await race(
      d1,
      /SELECT COUNT\(\*\) AS cnt FROM documents/,
      20,
      () =>
        new Request(url('/db/posts'), {
          method: 'POST',
          headers: { ...auth, 'Content-Type': 'application/json' },
          body: '{"x":1}',
        }),
    );
    expect(statuses.filter((s) => s === 201)).toHaveLength(1);
    expect(count(db, "SELECT COUNT(*) AS n FROM documents WHERE collection = 'posts'")).toBe(10000);
  });

  it('documents: concurrent PUTs of different fields both land (no lost update)', async () => {
    const { db, d1, auth, now } = await setup();
    db.prepare(
      "INSERT INTO documents (app_id, collection, id, data, owner_id, created_at, updated_at) VALUES ('timer', 'posts', 'p1', '{\"title\":\"t\"}', 'gh:1', ?, ?)",
    ).run(now, now);
    const patches = ['{"a":1}', '{"b":2}', '{"c":3}'];
    const statuses = await race(
      d1,
      /SELECT data, owner_id, created_at FROM documents/,
      3,
      (i) =>
        new Request(url('/db/posts/p1'), {
          method: 'PUT',
          headers: { ...auth, 'Content-Type': 'application/json' },
          body: patches[i],
        }),
    );
    expect(statuses).toEqual([200, 200, 200]);
    const row = db.prepare("SELECT data FROM documents WHERE id = 'p1'").get() as { data: string };
    expect(JSON.parse(row.data)).toEqual({ title: 't', a: 1, b: 2, c: 3 });
  });

  it('webhooks: 10 parallel creates at 4/5, exactly one lands', async () => {
    const { db, d1, auth } = await setup();
    const ins = db.prepare(
      "INSERT INTO app_webhooks (id, app_id, event, url, secret) VALUES (?, 'timer', 'kv.changed', 'https://example.com/h', 's')",
    );
    for (let i = 0; i < 4; i++) ins.run(`w${i}`);
    const statuses = await race(
      d1,
      /SELECT COUNT\(\*\) AS n FROM app_webhooks/,
      10,
      () =>
        new Request(url('/webhooks'), {
          method: 'POST',
          headers: { ...auth, 'Content-Type': 'application/json' },
          body: JSON.stringify({ event: 'kv.changed', url: 'https://example.com/hook' }),
        }),
    );
    expect(statuses.filter((s) => s === 200)).toHaveLength(1);
    expect(statuses.filter((s) => s === 409)).toHaveLength(9);
    expect(count(db, "SELECT COUNT(*) AS n FROM app_webhooks WHERE app_id = 'timer'")).toBe(5);
  });

  it('email: 10 parallel sends at 49/50 for a user, exactly one goes out', async () => {
    const { db, d1, auth } = await setup();
    db.prepare('INSERT INTO app_proxy_usage (app_id, day, count) VALUES (?, ?, 49)').run(
      'email-user:gh:1',
      dayKey(Date.now()),
    );
    let sent = 0;
    const EMAIL = {
      send: async () => {
        sent += 1;
        return { messageId: 'm' };
      },
    };
    const statuses = await race(
      d1,
      /SELECT count FROM app_proxy_usage/,
      10,
      () =>
        new Request(url('/email/send'), {
          method: 'POST',
          headers: { ...auth, 'Content-Type': 'application/json' },
          body: JSON.stringify({ to: 'a@b.com', subject: 'hi', text: 'hello' }),
        }),
      { EMAIL },
    );
    expect(statuses.filter((s) => s === 200)).toHaveLength(1);
    expect(sent).toBe(1);
  });
});
