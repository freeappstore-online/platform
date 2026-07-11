import { describe, expect, it } from 'vitest';
import { app } from '../index.js';
import { signSession } from '../lib/session.js';

const SIGNING_KEY = 'a'.repeat(64);

function fakeDB(opts: {
  user?: Record<string, unknown> | null;
  users?: Array<Record<string, unknown>>;
  providers?: Array<Record<string, unknown>>;
  keys?: Array<Record<string, unknown>>;
  grant?: Record<string, unknown> | null;
  grants?: Array<Record<string, unknown>>;
  provider?: Record<string, unknown> | null;
  runs?: Array<{ sql: string; binds: unknown[] }>;
}) {
  return {
    prepare: (sql: string) => {
      const trimmed = sql.replace(/\s+/g, ' ').trim();
      let bound: unknown[] = [];
      const result = {
        first: async () => {
          if (trimmed.includes('FROM users')) return opts.user ?? null;
          if (trimmed.includes('FROM key_providers')) return opts.provider ?? null;
          if (trimmed.includes('FROM complimentary_grants')) return opts.grant ?? null;
          return null;
        },
        all: async () => {
          if (trimmed.includes('FROM key_providers')) return { results: opts.providers ?? [] };
          if (trimmed.includes('FROM user_api_keys')) return { results: opts.keys ?? [] };
          if (trimmed.includes('FROM users')) return { results: opts.users ?? [] };
          if (trimmed.includes('FROM complimentary_grants')) return { results: opts.grants ?? [] };
          return { results: [] };
        },
        run: async () => {
          opts.runs?.push({ sql: trimmed, binds: bound });
          return { meta: { changes: 1 } };
        },
      };
      return {
        ...result,
        bind: (...args: unknown[]) => {
          bound = args;
          return result;
        },
      };
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
  const providers = [
    { id: 'openai', name: 'OpenAI', docs_url: 'https://openai.com', key_prefix: 'sk-' },
  ];
  const internalEnv = {
    ADMIN_PROVISION_TOKEN: 'internal-token',
    APP_SECRET_KEK: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=',
    COMP_KEY_ANTHROPIC: 'sk-ant-platform',
  };

  it('GET /v1/keys/providers returns providers (no auth)', async () => {
    const res = await app.request('/v1/keys/providers', {}, env(fakeDB({ providers })));
    expect(res.status).toBe(200);
    const data = (await res.json()) as { providers: unknown[] };
    expect(data.providers).toHaveLength(1);
  });

  it('GET /v1/keys/status returns 401 without auth', async () => {
    const res = await app.request('/v1/keys/status', {}, env(fakeDB({})));
    expect(res.status).toBe(401);
  });

  it('GET /v1/keys/status returns user keys', async () => {
    const keys = [{ provider: 'openai', label: 'work', created_at: 1000, last_used_at: null }];
    const res = await app.request(
      '/v1/keys/status',
      {
        headers: { Authorization: await authHeader() },
      },
      env(fakeDB({ user, keys })),
    );
    expect(res.status).toBe(200);
    const data = (await res.json()) as { keys: Array<{ provider: string }> };
    expect(data.keys).toHaveLength(1);
    expect(data.keys[0]!.provider).toBe('openai');
  });

  it('PUT /v1/keys/:provider returns 503 without APP_SECRET_KEK', async () => {
    const res = await app.request(
      '/v1/keys/openai',
      {
        method: 'PUT',
        headers: { Authorization: await authHeader(), 'Content-Type': 'application/json' },
        body: JSON.stringify({ value: 'sk-test123' }),
      },
      env(fakeDB({ user, provider: { id: 'openai', key_prefix: 'sk-' } })),
    );
    expect(res.status).toBe(503);
  });

  it('PUT /v1/keys/:provider returns 400 for unknown provider', async () => {
    const res = await app.request(
      '/v1/keys/unknown',
      {
        method: 'PUT',
        headers: { Authorization: await authHeader(), 'Content-Type': 'application/json' },
        body: JSON.stringify({ value: 'test-key' }),
      },
      env(fakeDB({ user, provider: null }), { APP_SECRET_KEK: 'b'.repeat(64) }),
    );
    expect(res.status).toBe(400);
  });

  it('PUT /v1/keys/:provider returns 400 for wrong prefix', async () => {
    const res = await app.request(
      '/v1/keys/openai',
      {
        method: 'PUT',
        headers: { Authorization: await authHeader(), 'Content-Type': 'application/json' },
        body: JSON.stringify({ value: 'wrong-prefix-key' }),
      },
      env(fakeDB({ user, provider: { id: 'openai', key_prefix: 'sk-' } }), {
        APP_SECRET_KEK: 'b'.repeat(64),
      }),
    );
    expect(res.status).toBe(400);
  });

  it('DELETE /v1/keys/:provider returns 401 without auth', async () => {
    const res = await app.request('/v1/keys/openai', { method: 'DELETE' }, env(fakeDB({})));
    expect(res.status).toBe(401);
  });

  it('DELETE /v1/keys/:provider deletes key', async () => {
    const res = await app.request(
      '/v1/keys/openai',
      {
        method: 'DELETE',
        headers: { Authorization: await authHeader() },
      },
      env(fakeDB({ user })),
    );
    expect(res.status).toBe(200);
    const data = (await res.json()) as { ok: boolean };
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
    const res = await app.request(
      '/v1/keys',
      {
        headers: { Authorization: await authHeader(), Accept: 'application/json' },
      },
      env(fakeDB({ user, keys })),
    );
    expect(res.status).toBe(200);
    const data = (await res.json()) as { keys: unknown[] };
    expect(data.keys).toHaveLength(1);
  });

  it('GET /v1/keys HTML mode does not let ?provider break out of the inline script (XSS)', async () => {
    const payload = "</script><script>alert(1)</script>";
    const res = await app.request(
      `/v1/keys?provider=${encodeURIComponent(payload)}`,
      {},
      env(fakeDB({})),
    );
    expect(res.status).toBe(200);
    const html = await res.text();
    // The raw closing tag must not appear — it must be escaped to <.
    expect(html).not.toContain('</script><script>alert(1)');
    expect(html).toContain('\\u003c/script');
  });

  it('GET /v1/keys HTML mode drops a javascript: return URL (no clickable XSS link)', async () => {
    const res = await app.request(
      `/v1/keys?app=demo&return=${encodeURIComponent('javascript:alert(1)')}`,
      {},
      env(fakeDB({})),
    );
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).not.toContain('javascript:alert(1)');
  });

  it('GET /v1/internal/keys/users requires the internal token', async () => {
    const res = await app.request('/v1/internal/keys/users', {}, env(fakeDB({})));
    expect(res.status).toBe(403);
  });

  it('GET /v1/internal/keys/users lists users with configured providers', async () => {
    const res = await app.request(
      '/v1/internal/keys/users',
      { headers: { 'X-Internal-Token': 'internal-token' } },
      env(
        fakeDB({
          users: [{ id: 'gh:1', github_login: 'alice', display_name: 'Alice', avatar_url: null, created_at: 123 }],
          keys: [{ user_id: 'gh:1', provider: 'openai', label: 'Admin', created_at: 456, last_used_at: null }],
        }),
        internalEnv,
      ),
    );
    expect(res.status).toBe(200);
    const data = (await res.json()) as { users: Array<{ id: string; keys: Array<{ provider: string }> }> };
    expect(data.users[0]!.id).toBe('gh:1');
    expect(data.users[0]!.keys[0]!.provider).toBe('openai');
  });

  it('POST /v1/internal/keys/userkey validates provider prefixes', async () => {
    const res = await app.request(
      '/v1/internal/keys/userkey',
      {
        method: 'POST',
        headers: { 'X-Internal-Token': 'internal-token', 'Content-Type': 'application/json' },
        body: JSON.stringify({ userId: 'gh:1', provider: 'openai', key: 'bad-key' }),
      },
      env(
        fakeDB({
          user: { id: 'gh:1' },
          provider: { id: 'openai', key_prefix: 'sk-' },
        }),
        internalEnv,
      ),
    );
    expect(res.status).toBe(400);
  });

  it('POST /v1/internal/keys/userkey stores an encrypted user key', async () => {
    const runs: Array<{ sql: string; binds: unknown[] }> = [];
    const res = await app.request(
      '/v1/internal/keys/userkey',
      {
        method: 'POST',
        headers: { 'X-Internal-Token': 'internal-token', 'Content-Type': 'application/json' },
        body: JSON.stringify({ userId: 'gh:1', provider: 'openai', key: 'sk-test-key', label: 'Admin provisioned' }),
      },
      env(
        fakeDB({
          user: { id: 'gh:1' },
          provider: { id: 'openai', key_prefix: 'sk-' },
          runs,
        }),
        internalEnv,
      ),
    );
    expect(res.status).toBe(200);
    expect(runs[0]!.sql).toContain('INSERT INTO user_api_keys');
    expect(runs[0]!.binds.slice(0, 3)).toEqual(['gh:1', 'openai', 'Admin provisioned']);
    expect(runs[0]!.binds[3]).toBeInstanceOf(Uint8Array);
  });

  it('POST /v1/internal/keys/userkey/delete removes a user key', async () => {
    const runs: Array<{ sql: string; binds: unknown[] }> = [];
    const res = await app.request(
      '/v1/internal/keys/userkey/delete',
      {
        method: 'POST',
        headers: { 'X-Internal-Token': 'internal-token', 'Content-Type': 'application/json' },
        body: JSON.stringify({ userId: 'gh:1', provider: 'openai' }),
      },
      env(fakeDB({ runs }), internalEnv),
    );
    expect(res.status).toBe(200);
    expect(runs[0]!.sql).toContain('DELETE FROM user_api_keys');
    expect(runs[0]!.binds).toEqual(['gh:1', 'openai']);
  });

  it('GET /v1/internal/keys/grants lists grants and funded providers', async () => {
    const res = await app.request(
      '/v1/internal/keys/grants',
      { headers: { 'X-Internal-Token': 'internal-token' } },
      env(
        fakeDB({
          grants: [{ user_id: 'gh:1', provider: 'anthropic', model: 'claude-sonnet-4-6', granted_by: 'admin', note: null, created_at: 123, expires_at: null }],
        }),
        internalEnv,
      ),
    );
    expect(res.status).toBe(200);
    const data = (await res.json()) as { grants: Array<{ userId: string }>; funded: string[] };
    expect(data.grants[0]!.userId).toBe('gh:1');
    expect(data.funded).toContain('anthropic');
  });

  it('POST /v1/internal/keys/grants stores a complimentary grant', async () => {
    const runs: Array<{ sql: string; binds: unknown[] }> = [];
    const res = await app.request(
      '/v1/internal/keys/grants',
      {
        method: 'POST',
        headers: { 'X-Internal-Token': 'internal-token', 'Content-Type': 'application/json' },
        body: JSON.stringify({ userId: 'gh:1', provider: 'anthropic', model: 'claude-sonnet-4-6', note: 'beta' }),
      },
      env(fakeDB({ user: { id: 'gh:1' }, runs }), internalEnv),
    );
    expect(res.status).toBe(200);
    expect(runs.some((r) => r.sql.includes('INSERT INTO complimentary_grants'))).toBe(true);
  });

  it('POST /v1/internal/keys/grants stores an unfunded complimentary grant', async () => {
    const runs: Array<{ sql: string; binds: unknown[] }> = [];
    const res = await app.request(
      '/v1/internal/keys/grants',
      {
        method: 'POST',
        headers: { 'X-Internal-Token': 'internal-token', 'Content-Type': 'application/json' },
        body: JSON.stringify({ userId: 'gh:1', provider: 'anthropic', model: 'claude-sonnet-4-6' }),
      },
      env(fakeDB({ user: { id: 'gh:1' }, runs }), {
        ADMIN_PROVISION_TOKEN: 'internal-token',
        APP_SECRET_KEK: internalEnv.APP_SECRET_KEK,
      }),
    );
    expect(res.status).toBe(200);
    const data = (await res.json()) as { funded: boolean };
    expect(data.funded).toBe(false);
    expect(runs.some((r) => r.sql.includes('INSERT INTO complimentary_grants'))).toBe(true);
  });

  it('POST /v1/internal/keys/grants/delete revokes a complimentary grant', async () => {
    const runs: Array<{ sql: string; binds: unknown[] }> = [];
    const res = await app.request(
      '/v1/internal/keys/grants/delete',
      {
        method: 'POST',
        headers: { 'X-Internal-Token': 'internal-token', 'Content-Type': 'application/json' },
        body: JSON.stringify({ userId: 'gh:1' }),
      },
      env(fakeDB({ runs }), internalEnv),
    );
    expect(res.status).toBe(200);
    expect(runs.some((r) => r.sql.includes('DELETE FROM complimentary_grants'))).toBe(true);
  });

  it('GET /v1/keys/resolve-agent falls back to active complimentary grant', async () => {
    const token = await signSession('gh:1', SIGNING_KEY);
    const res = await app.request(
      'https://backend/v1/keys/resolve-agent/anthropic',
      {
        headers: { Authorization: `Bearer ${token}` },
      },
      env(
        fakeDB({
          user: { id: 'gh:1', github_login: 'alice', avatar_url: null, date_of_birth: null },
          grant: { user_id: 'gh:1', provider: 'anthropic', model: 'claude-sonnet-4-6', granted_by: 'admin', note: null, created_at: 123, expires_at: null },
        }),
        internalEnv,
      ),
    );
    expect(res.status).toBe(200);
    const data = (await res.json()) as { key: string | null; provider: string; model: string; source: string };
    expect(data.key).toBe('sk-ant-platform');
    expect(data.provider).toBe('anthropic');
    expect(data.model).toBe('claude-sonnet-4-6');
    expect(data.source).toBe('grant');
  });
});
