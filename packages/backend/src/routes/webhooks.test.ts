import { describe, expect, it } from 'vitest';
import { app } from '../index.js';
import { signSession } from '../lib/session.js';

const SIGNING_KEY = 'a'.repeat(64);

function fakeDB(opts: {
  user?: Record<string, unknown> | null;
  webhooks?: Array<Record<string, unknown>>;
  count?: number;
}) {
  return {
    prepare: (sql: string) => {
      const trimmed = sql.replace(/\s+/g, ' ').trim();
      return {
        bind: (..._args: unknown[]) => ({
          first: async () => {
            if (trimmed.includes('FROM users')) return opts.user ?? null;
            if (trimmed.includes('COUNT(*)')) return { n: opts.count ?? 0 };
            if (trimmed.includes('FROM app_webhooks') && trimmed.includes('id = ?')) return opts.webhooks?.[0] ?? null;
            return null;
          },
          all: async () => ({ results: opts.webhooks ?? [] }),
          run: async () => ({ meta: { changes: 1 } }),
        }),
      };
    },
  } as unknown as D1Database;
}

function env(db: D1Database) {
  return { DB: db, SESSION_SIGNING_KEY: SIGNING_KEY };
}

async function authHeader(userId = 'u1') {
  const token = await signSession(userId, SIGNING_KEY);
  return `Bearer ${token}`;
}

describe('webhook routes', () => {
  const user = { id: 'u1', github_login: 'test', avatar_url: null, date_of_birth: null };

  it('GET /v1/apps/:appId/webhooks returns 401 without auth', async () => {
    const res = await app.request('/v1/apps/timer/webhooks', {}, env(fakeDB({})));
    expect(res.status).toBe(401);
  });

  it('GET /v1/apps/:appId/webhooks returns webhook list', async () => {
    const webhooks = [{ id: 'w1', event: 'kv.changed', url: 'https://example.com/hook', active: 1, created_at: 1000 }];
    const res = await app.request('/v1/apps/timer/webhooks', {
      headers: { Authorization: await authHeader() },
    }, env(fakeDB({ user, webhooks })));
    expect(res.status).toBe(200);
    const data = await res.json() as { webhooks: unknown[]; supported_events: string[] };
    expect(data.webhooks).toHaveLength(1);
    expect(data.supported_events.length).toBeGreaterThan(0);
  });

  it('POST /v1/apps/:appId/webhooks returns 400 for missing fields', async () => {
    const res = await app.request('/v1/apps/timer/webhooks', {
      method: 'POST',
      headers: { Authorization: await authHeader(), 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    }, env(fakeDB({ user })));
    expect(res.status).toBe(400);
  });

  it('POST /v1/apps/:appId/webhooks returns 400 for unsupported event', async () => {
    const res = await app.request('/v1/apps/timer/webhooks', {
      method: 'POST',
      headers: { Authorization: await authHeader(), 'Content-Type': 'application/json' },
      body: JSON.stringify({ event: 'invalid.event', url: 'https://example.com/hook' }),
    }, env(fakeDB({ user })));
    expect(res.status).toBe(400);
  });

  it('POST /v1/apps/:appId/webhooks returns 400 for non-HTTPS URL', async () => {
    const res = await app.request('/v1/apps/timer/webhooks', {
      method: 'POST',
      headers: { Authorization: await authHeader(), 'Content-Type': 'application/json' },
      body: JSON.stringify({ event: 'kv.changed', url: 'http://example.com/hook' }),
    }, env(fakeDB({ user })));
    expect(res.status).toBe(400);
  });

  it('POST /v1/apps/:appId/webhooks returns 409 when at cap', async () => {
    const res = await app.request('/v1/apps/timer/webhooks', {
      method: 'POST',
      headers: { Authorization: await authHeader(), 'Content-Type': 'application/json' },
      body: JSON.stringify({ event: 'kv.changed', url: 'https://example.com/hook' }),
    }, env(fakeDB({ user, count: 5 })));
    expect(res.status).toBe(409);
  });

  it('POST /v1/apps/:appId/webhooks creates webhook', async () => {
    const res = await app.request('/v1/apps/timer/webhooks', {
      method: 'POST',
      headers: { Authorization: await authHeader(), 'Content-Type': 'application/json' },
      body: JSON.stringify({ event: 'kv.changed', url: 'https://example.com/hook' }),
    }, env(fakeDB({ user, count: 0 })));
    expect(res.status).toBe(200);
    const data = await res.json() as { id: string; secret: string };
    expect(data.id).toBeDefined();
    expect(data.secret).toBeDefined();
    expect(data.secret.length).toBeGreaterThan(30);
  });

  it('DELETE /v1/apps/:appId/webhooks/:id deletes webhook', async () => {
    const res = await app.request('/v1/apps/timer/webhooks/w1', {
      method: 'DELETE',
      headers: { Authorization: await authHeader() },
    }, env(fakeDB({ user })));
    expect(res.status).toBe(200);
  });
});
