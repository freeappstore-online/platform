import { describe, expect, it } from 'vitest';
import { app } from '../index.js';
import { signSession } from '../lib/session.js';

const SIGNING_KEY = 'a'.repeat(64);

function fakeDB(opts: {
  user?: Record<string, unknown> | null;
  providers?: Array<Record<string, unknown>>;
  keys?: Array<Record<string, unknown>>;
  provider?: Record<string, unknown> | null;
}) {
  return {
    prepare: (sql: string) => {
      const trimmed = sql.replace(/\s+/g, ' ').trim();
      const result = {
        first: async () => {
          if (trimmed.includes('FROM users')) return opts.user ?? null;
          if (trimmed.includes('FROM key_providers')) return opts.provider ?? null;
          return null;
        },
        all: async () => {
          if (trimmed.includes('FROM key_providers')) return { results: opts.providers ?? [] };
          if (trimmed.includes('FROM user_api_keys')) return { results: opts.keys ?? [] };
          return { results: [] };
        },
        run: async () => ({ meta: { changes: 1 } }),
      };
      return { ...result, bind: (..._args: unknown[]) => result };
    },
  } as unknown as D1Database;
}

function env(db: D1Database, extraEnv?: Record<string, unknown>) {
  return { DB: db, SESSION_SIGNING_KEY: SIGNING_KEY, ...extraEnv };
}

async function authHeader() {
  const token = await signSession('u1', SIGNING_KEY);
  return `Bearer ${token}`;
}

describe('keys routes', () => {
  const user = { id: 'u1', github_login: 'test', avatar_url: null, date_of_birth: null };
  const providers = [{ id: 'openai', name: 'OpenAI', docs_url: 'https://openai.com', key_prefix: 'sk-' }];

  it('GET /v1/keys/providers returns providers (no auth)', async () => {
    const res = await app.request('/v1/keys/providers', {}, env(fakeDB({ providers })));
    expect(res.status).toBe(200);
    const data = await res.json() as { providers: unknown[] };
    expect(data.providers).toHaveLength(1);
  });

  it('GET /v1/keys/status returns 401 without auth', async () => {
    const res = await app.request('/v1/keys/status', {}, env(fakeDB({})));
    expect(res.status).toBe(401);
  });

  it('GET /v1/keys/status returns user keys', async () => {
    const keys = [{ provider: 'openai', label: 'work', created_at: 1000, last_used_at: null }];
    const res = await app.request('/v1/keys/status', {
      headers: { Authorization: await authHeader() },
    }, env(fakeDB({ user, keys })));
    expect(res.status).toBe(200);
    const data = await res.json() as { keys: Array<{ provider: string }> };
    expect(data.keys).toHaveLength(1);
    expect(data.keys[0].provider).toBe('openai');
  });

  it('PUT /v1/keys/:provider returns 503 without APP_SECRET_KEK', async () => {
    const res = await app.request('/v1/keys/openai', {
      method: 'PUT',
      headers: { Authorization: await authHeader(), 'Content-Type': 'application/json' },
      body: JSON.stringify({ value: 'sk-test123' }),
    }, env(fakeDB({ user, provider: { id: 'openai', key_prefix: 'sk-' } })));
    expect(res.status).toBe(503);
  });

  it('PUT /v1/keys/:provider returns 400 for unknown provider', async () => {
    const res = await app.request('/v1/keys/unknown', {
      method: 'PUT',
      headers: { Authorization: await authHeader(), 'Content-Type': 'application/json' },
      body: JSON.stringify({ value: 'test-key' }),
    }, env(fakeDB({ user, provider: null }), { APP_SECRET_KEK: 'b'.repeat(64) }));
    expect(res.status).toBe(400);
  });

  it('PUT /v1/keys/:provider returns 400 for wrong prefix', async () => {
    const res = await app.request('/v1/keys/openai', {
      method: 'PUT',
      headers: { Authorization: await authHeader(), 'Content-Type': 'application/json' },
      body: JSON.stringify({ value: 'wrong-prefix-key' }),
    }, env(fakeDB({ user, provider: { id: 'openai', key_prefix: 'sk-' } }), { APP_SECRET_KEK: 'b'.repeat(64) }));
    expect(res.status).toBe(400);
  });

  it('DELETE /v1/keys/:provider returns 401 without auth', async () => {
    const res = await app.request('/v1/keys/openai', { method: 'DELETE' }, env(fakeDB({})));
    expect(res.status).toBe(401);
  });

  it('DELETE /v1/keys/:provider deletes key', async () => {
    const res = await app.request('/v1/keys/openai', {
      method: 'DELETE',
      headers: { Authorization: await authHeader() },
    }, env(fakeDB({ user })));
    expect(res.status).toBe(200);
    const data = await res.json() as { ok: boolean };
    expect(data.ok).toBe(true);
  });

  it('GET /v1/keys returns HTML page by default', async () => {
    const res = await app.request('/v1/keys', {}, env(fakeDB({})));
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).toContain('API Keys');
  });

  it('GET /v1/keys returns JSON when Accept: application/json', async () => {
    const keys = [{ provider: 'openai', label: null, created_at: 1000, last_used_at: null }];
    const res = await app.request('/v1/keys', {
      headers: { Authorization: await authHeader(), Accept: 'application/json' },
    }, env(fakeDB({ user, keys })));
    expect(res.status).toBe(200);
    const data = await res.json() as { keys: unknown[] };
    expect(data.keys).toHaveLength(1);
  });
});
