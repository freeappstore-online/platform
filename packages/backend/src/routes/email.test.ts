import { describe, expect, it } from 'vitest';
import { app } from '../index.js';
import { dayKey } from '../lib/proxy-rate-limit.js';
import { signSession } from '../lib/session.js';
import { hasSqlite, sqliteD1 } from '../lib/sqlite-d1.testutil.js';
import { DAILY_EMAIL_LIMIT_PLATFORM } from './email.js';

const SIGNING_KEY = 'a'.repeat(64);

function fakeDB(user: Record<string, unknown> | null) {
  return {
    prepare: (_sql: string) => ({
      bind: (..._args: unknown[]) => ({
        first: async () => user,
        run: async () => ({ meta: { changes: 1 } }),
        all: async () => ({ results: [] }),
      }),
    }),
  } as unknown as D1Database;
}

function env(db: D1Database, extra: Record<string, unknown> = {}) {
  return { DB: db, SESSION_SIGNING_KEY: SIGNING_KEY, ...extra };
}

async function authHeader(userId = 'u1') {
  const token = await signSession(userId, SIGNING_KEY, { aud: 'console' });
  return `Bearer ${token}`;
}

describe('email routes', () => {
  const user = { id: 'u1', github_login: 'test', avatar_url: null, date_of_birth: null };

  it('returns 401 without auth', async () => {
    const res = await app.request(
      '/v1/apps/timer/email/send',
      { method: 'POST' },
      env(fakeDB(null)),
    );
    expect(res.status).toBe(401);
  });

  it('returns 503 when the Email Service binding is missing', async () => {
    const res = await app.request(
      '/v1/apps/timer/email/send',
      {
        method: 'POST',
        headers: { Authorization: await authHeader(), 'Content-Type': 'application/json' },
        body: JSON.stringify({ to: 'a@b.com', subject: 'hi', text: 'hello' }),
      },
      env(fakeDB(user)),
    );
    expect(res.status).toBe(503);
  });

  it('returns 400 for missing to', async () => {
    const res = await app.request(
      '/v1/apps/timer/email/send',
      {
        method: 'POST',
        headers: { Authorization: await authHeader(), 'Content-Type': 'application/json' },
        body: JSON.stringify({ subject: 'hi', text: 'hello' }),
      },
      env(fakeDB(user), { EMAIL: { send: async () => ({ messageId: 'test' }) } }),
    );
    expect(res.status).toBe(400);
  });

  it('returns 400 for a non-string html body', async () => {
    const res = await app.request(
      '/v1/apps/timer/email/send',
      {
        method: 'POST',
        headers: { Authorization: await authHeader(), 'Content-Type': 'application/json' },
        body: JSON.stringify({ to: 'a@b.com', subject: 'hi', html: 123 }),
      },
      env(fakeDB(user), { EMAIL: { send: async () => ({ messageId: 'test' }) } }),
    );
    expect(res.status).toBe(400);
  });

  it('returns 400 for missing body (no html or text)', async () => {
    const res = await app.request(
      '/v1/apps/timer/email/send',
      {
        method: 'POST',
        headers: { Authorization: await authHeader(), 'Content-Type': 'application/json' },
        body: JSON.stringify({ to: 'a@b.com', subject: 'hi' }),
      },
      env(fakeDB(user), { EMAIL: { send: async () => ({ messageId: 'test' }) } }),
    );
    expect(res.status).toBe(400);
  });
});

describe.skipIf(!hasSqlite)('email daily quota against real SQLite', () => {
  function setup() {
    const { db, d1 } = sqliteD1();
    const now = Date.now();
    // alice (u1) owns timer; bob (u2) is a member with a verified address;
    // carol (u3) is signed in but has nothing to do with timer.
    db.prepare('INSERT INTO apps (id, owner_login, created_at) VALUES (?, ?, ?)').run(
      'timer',
      'alice',
      now,
    );
    const user = db.prepare(
      'INSERT INTO users (id, github_id, github_login, avatar_url, email, created_at) VALUES (?, ?, ?, NULL, ?, ?)',
    );
    user.run('u1', 1, 'alice', 'alice@example.com', now);
    user.run('u2', 2, 'bob', 'Bob@Example.com', now);
    user.run('u3', 3, 'carol', 'carol@example.com', now);
    db.prepare(
      "INSERT INTO app_roles (app_id, user_id, role_name, granted_by) VALUES ('timer', 'u2', 'member', NULL)",
    ).run();
    let sent = 0;
    const send = async () => {
      sent += 1;
      return { messageId: 'm' };
    };
    const e = env(d1, { EMAIL: { send } });
    const request = async (userId: string, to = 'a@b.com') =>
      (
        await app.request(
          '/v1/apps/timer/email/send',
          {
            method: 'POST',
            headers: {
              Authorization: await authHeader(userId),
              'Content-Type': 'application/json',
            },
            body: JSON.stringify({ to, subject: 'hi', text: 'hello' }),
          },
          e,
        )
      ).status;
    return { db, send: request, sent: () => sent };
  }

  it('sends exactly 50 per user per day, then 429', async () => {
    const { send, sent } = setup();
    for (let i = 0; i < 50; i++) expect(await send('u1')).toBe(200);
    expect(await send('u1')).toBe(429);
    expect(sent()).toBe(50);
  });

  it('a user over their limit does not use up the app quota', async () => {
    const { send } = setup();
    for (let i = 0; i < 50; i++) await send('u1');
    for (let i = 0; i < 20; i++) expect(await send('u1')).toBe(429);
    for (let i = 0; i < 50; i++) expect(await send('u2', 'bob@example.com')).toBe(200);
  });

  it('the owner may send to any recipient', async () => {
    const { send, sent } = setup();
    expect(await send('u1', 'anyone@elsewhere.test')).toBe(200);
    expect(sent()).toBe(1);
  });

  it('a signed-in user with no role in the app cannot send at all (#487)', async () => {
    const { send, sent } = setup();
    expect(await send('u3', 'carol@example.com')).toBe(403);
    expect(await send('u3', 'victim@elsewhere.test')).toBe(403);
    expect(sent()).toBe(0);
  });

  it('a member may only send to their own verified address (#487)', async () => {
    const { send, sent } = setup();
    expect(await send('u2', 'victim@elsewhere.test')).toBe(403);
    expect(await send('u2', 'alice@example.com')).toBe(403);
    expect(sent()).toBe(0);
    // Case-insensitive: the stored address is Bob@Example.com.
    expect(await send('u2', 'bob@example.com')).toBe(200);
    expect(sent()).toBe(1);
  });

  it('a 403 does not consume the sender or app quota', async () => {
    const { db, send } = setup();
    await send('u2', 'victim@elsewhere.test');
    const rows = db.prepare('SELECT COUNT(*) AS n FROM app_proxy_usage').get() as { n: number };
    expect(rows.n).toBe(0);
  });

  it('stops at the platform-wide daily cap (#487)', async () => {
    const { db, send, sent } = setup();
    db.prepare('INSERT INTO app_proxy_usage (app_id, day, count) VALUES (?, ?, ?)').run(
      'email-platform',
      dayKey(Date.now()),
      DAILY_EMAIL_LIMIT_PLATFORM - 1,
    );
    expect(await send('u1')).toBe(200);
    expect(await send('u1')).toBe(429);
    expect(sent()).toBe(1);
  });
});
