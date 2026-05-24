import { describe, expect, it } from 'vitest';
import { app } from '../index.js';
import { signSession } from '../lib/session.js';

const SIGNING_KEY = 'a'.repeat(64);

function fakeDB(user: Record<string, unknown> | null) {
  return {
    prepare: (sql: string) => ({
      bind: (..._args: unknown[]) => ({
        first: async () => {
          if (sql.includes('FROM users')) return user;
          if (sql.includes('FROM app_logs') && sql.includes('build_meta IS NOT NULL'))
            return { build_meta: '{"sdkVersion":"0.12.0"}', ts: 1000 };
          return null;
        },
        all: async () => ({ results: [] }),
        run: async () => ({ meta: { changes: 0 } }),
      }),
    }),
    batch: async () => {},
  } as unknown as D1Database;
}

function env(db: D1Database) {
  return { DB: db, SESSION_SIGNING_KEY: SIGNING_KEY };
}

async function authHeader(userId = 'u1') {
  const token = await signSession({ uid: userId, iat: Math.floor(Date.now() / 1000), exp: Math.floor(Date.now() / 1000) + 3600 }, SIGNING_KEY);
  return `Bearer ${token}`;
}

describe('logs routes', () => {
  const user = { id: 'u1', github_login: 'test', avatar_url: null, date_of_birth: null };

  it('POST /v1/apps/:appId/logs returns 401 without auth', async () => {
    const res = await app.request('/v1/apps/timer/logs', { method: 'POST' }, env(fakeDB(null)));
    expect(res.status).toBe(401);
  });

  it('POST /v1/apps/:appId/logs returns 400 for missing entries', async () => {
    const res = await app.request('/v1/apps/timer/logs', {
      method: 'POST',
      headers: { Authorization: await authHeader(), 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    }, env(fakeDB(user)));
    expect(res.status).toBe(400);
  });

  it('POST /v1/apps/:appId/logs ingests valid entries', async () => {
    const res = await app.request('/v1/apps/timer/logs', {
      method: 'POST',
      headers: { Authorization: await authHeader(), 'Content-Type': 'application/json' },
      body: JSON.stringify({
        entries: [
          { ts: Date.now(), level: 'info', category: 'app', message: 'test' },
          { ts: Date.now(), level: 'error', category: 'sdk', message: 'oops', data: { code: 500 } },
        ],
      }),
    }, env(fakeDB(user)));
    expect(res.status).toBe(200);
    const data = await res.json() as { ok: boolean; ingested: number };
    expect(data.ok).toBe(true);
    expect(data.ingested).toBe(2);
  });

  it('GET /v1/apps/:appId/logs returns 401 without auth', async () => {
    const res = await app.request('/v1/apps/timer/logs', {}, env(fakeDB(null)));
    expect(res.status).toBe(401);
  });

  it('GET /v1/apps/:appId/logs returns logs list', async () => {
    const res = await app.request('/v1/apps/timer/logs', {
      headers: { Authorization: await authHeader() },
    }, env(fakeDB(user)));
    expect(res.status).toBe(200);
    const data = await res.json() as { logs: unknown[] };
    expect(Array.isArray(data.logs)).toBe(true);
  });

  it('GET /v1/apps/:appId/logs/build returns build metadata', async () => {
    const res = await app.request('/v1/apps/timer/logs/build', {
      headers: { Authorization: await authHeader() },
    }, env(fakeDB(user)));
    expect(res.status).toBe(200);
    const data = await res.json() as { build: Record<string, unknown>; ts: number };
    expect(data.build.sdkVersion).toBe('0.12.0');
  });
});
