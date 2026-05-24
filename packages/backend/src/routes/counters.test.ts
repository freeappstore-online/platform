import { describe, expect, it } from 'vitest';
import { app } from '../index.js';
import { signSession } from '../lib/session.js';

const SIGNING_KEY = 'a'.repeat(64);

function fakeDB(opts: {
  user?: Record<string, unknown> | null;
  counters?: Record<string, number>;
  counterCount?: number;
  counterExists?: boolean;
}) {
  return {
    prepare: (sql: string) => {
      const trimmed = sql.replace(/\s+/g, ' ').trim();
      const result = {
        first: async () => {
          if (trimmed.includes('FROM users')) return opts.user ?? null;
          if (trimmed.includes('SELECT value FROM counters')) {
            const key = Object.keys(opts.counters ?? {})[0];
            return key ? { value: opts.counters![key] } : null;
          }
          if (trimmed.includes('COUNT(*)')) return { cnt: opts.counterCount ?? 0 };
          if (trimmed.includes('SELECT 1 FROM counters')) return opts.counterExists ? { 1: 1 } : null;
          return null;
        },
        all: async () => {
          if (trimmed.includes('FROM counters')) {
            const entries = Object.entries(opts.counters ?? {}).map(([key, value]) => ({ key, value }));
            return { results: entries };
          }
          return { results: [] };
        },
        run: async () => ({ meta: { changes: 1 } }),
      };
      return { ...result, bind: (..._args: unknown[]) => result };
    },
  } as unknown as D1Database;
}

function env(db: D1Database) {
  return { DB: db, SESSION_SIGNING_KEY: SIGNING_KEY };
}

async function authHeader() {
  const token = await signSession({ uid: 'u1', iat: Math.floor(Date.now() / 1000), exp: Math.floor(Date.now() / 1000) + 3600 }, SIGNING_KEY);
  return `Bearer ${token}`;
}

describe('counter routes', () => {
  const user = { id: 'u1', github_login: 'test', avatar_url: null, date_of_birth: null };

  it('GET /v1/apps/:appId/counters lists counters (no auth required)', async () => {
    const res = await app.request('/v1/apps/timer/counters', {}, env(fakeDB({ counters: { views: 42 } })));
    expect(res.status).toBe(200);
    const data = await res.json() as Record<string, number>;
    expect(data.views).toBe(42);
  });

  it('GET /v1/apps/:appId/counters/:key returns single counter', async () => {
    const res = await app.request('/v1/apps/timer/counters/views', {}, env(fakeDB({ counters: { views: 10 } })));
    expect(res.status).toBe(200);
    const data = await res.json() as { value: number };
    expect(data.value).toBe(10);
  });

  it('GET /v1/apps/:appId/counters/:key returns 0 for missing counter', async () => {
    const res = await app.request('/v1/apps/timer/counters/missing', {}, env(fakeDB({ counters: {} })));
    expect(res.status).toBe(200);
    const data = await res.json() as { value: number };
    expect(data.value).toBe(0);
  });

  it('POST /v1/apps/:appId/counters/:key requires auth', async () => {
    const res = await app.request('/v1/apps/timer/counters/views', { method: 'POST' }, env(fakeDB({})));
    expect(res.status).toBe(401);
  });

  it('POST /v1/apps/:appId/counters/:key increments counter', async () => {
    const res = await app.request('/v1/apps/timer/counters/views', {
      method: 'POST',
      headers: { Authorization: await authHeader(), 'Content-Type': 'application/json' },
      body: JSON.stringify({ increment: 5 }),
    }, env(fakeDB({ user, counters: { views: 15 }, counterCount: 1 })));
    expect(res.status).toBe(200);
    const data = await res.json() as { value: number };
    expect(typeof data.value).toBe('number');
  });

  it('POST /v1/apps/:appId/counters/:key rejects too-long key', async () => {
    const longKey = 'a'.repeat(200);
    const res = await app.request(`/v1/apps/timer/counters/${longKey}`, {
      method: 'POST',
      headers: { Authorization: await authHeader(), 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    }, env(fakeDB({ user })));
    expect(res.status).toBe(400);
  });

  it('POST /v1/apps/:appId/counters/:key rejects out-of-range increment', async () => {
    const res = await app.request('/v1/apps/timer/counters/views', {
      method: 'POST',
      headers: { Authorization: await authHeader(), 'Content-Type': 'application/json' },
      body: JSON.stringify({ increment: 9999 }),
    }, env(fakeDB({ user })));
    expect(res.status).toBe(400);
  });
});
