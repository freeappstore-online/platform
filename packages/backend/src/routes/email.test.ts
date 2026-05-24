import { describe, expect, it } from 'vitest';
import { app } from '../index.js';
import { signSession } from '../lib/session.js';

const SIGNING_KEY = 'a'.repeat(64);

function fakeDB(user: Record<string, unknown> | null) {
  return {
    prepare: (sql: string) => ({
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
  const token = await signSession(userId, SIGNING_KEY);
  return `Bearer ${token}`;
}

describe('email routes', () => {
  const user = { id: 'u1', github_login: 'test', avatar_url: null, date_of_birth: null };

  it('returns 401 without auth', async () => {
    const res = await app.request('/v1/apps/timer/email/send', { method: 'POST' }, env(fakeDB(null)));
    expect(res.status).toBe(401);
  });

  it('returns 503 when RESEND_API_KEY is missing', async () => {
    const res = await app.request('/v1/apps/timer/email/send', {
      method: 'POST',
      headers: { Authorization: await authHeader(), 'Content-Type': 'application/json' },
      body: JSON.stringify({ to: 'a@b.com', subject: 'hi', text: 'hello' }),
    }, env(fakeDB(user)));
    expect(res.status).toBe(503);
  });

  it('returns 400 for missing to', async () => {
    const res = await app.request('/v1/apps/timer/email/send', {
      method: 'POST',
      headers: { Authorization: await authHeader(), 'Content-Type': 'application/json' },
      body: JSON.stringify({ subject: 'hi', text: 'hello' }),
    }, env(fakeDB(user), { RESEND_API_KEY: 'test', EMAIL_FROM: 'test@test.com' }));
    expect(res.status).toBe(400);
  });

  it('returns 400 for missing body (no html or text)', async () => {
    const res = await app.request('/v1/apps/timer/email/send', {
      method: 'POST',
      headers: { Authorization: await authHeader(), 'Content-Type': 'application/json' },
      body: JSON.stringify({ to: 'a@b.com', subject: 'hi' }),
    }, env(fakeDB(user), { RESEND_API_KEY: 'test', EMAIL_FROM: 'test@test.com' }));
    expect(res.status).toBe(400);
  });
});
