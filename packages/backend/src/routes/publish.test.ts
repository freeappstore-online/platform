import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { app } from '../index.js';
import { signSession } from '../lib/session.js';
import type { Env } from '../types.js';

const SIGNING_KEY = 'a'.repeat(64);

function userLookupDB(user: { id: string; github_login: string; avatar_url: string | null } | null): D1Database {
  const prepare = (sql: string): D1PreparedStatement => {
    const trimmed = sql.replace(/\s+/g, ' ').trim();
    const stmt: Partial<D1PreparedStatement> = {
      bind: () => stmt as D1PreparedStatement,
      first: async <T>() => {
        if (trimmed.startsWith('SELECT id, github_login')) {
          return (user ?? null) as T | null;
        }
        return null;
      },
    };
    return stmt as D1PreparedStatement;
  };
  return { prepare } as unknown as D1Database;
}

const baseEnv = (db: D1Database, overrides: Partial<Env> = {}): Env => ({
  DB: db,
  ROOM: {} as DurableObjectNamespace,
  GITHUB_CLIENT_ID: 'cid',
  GITHUB_CLIENT_SECRET: 'csec',
  SESSION_SIGNING_KEY: SIGNING_KEY,
  ...overrides,
});

const validBody = {
  name: 'my-app',
  category: 'Productivity',
  type: 'standalone',
  oneliner: 'A simple test',
  description: 'Longer description here',
  repo: 'https://github.com/me/my-app',
  demo: null,
};

describe('POST /v1/publish', () => {
  let originalFetch: typeof fetch;
  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it('returns 401 with no auth', async () => {
    const res = await app.request(
      '/v1/publish',
      { method: 'POST', body: JSON.stringify(validBody) },
      baseEnv(userLookupDB(null)),
    );
    expect(res.status).toBe(401);
  });

  it('returns 400 for invalid app name', async () => {
    const token = await signSession('gh:1', SIGNING_KEY);
    const res = await app.request(
      '/v1/publish',
      {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...validBody, name: 'BadName' }),
      },
      baseEnv(userLookupDB({ id: 'gh:1', github_login: 'me', avatar_url: null })),
    );
    expect(res.status).toBe(400);
  });

  it('returns 400 for invalid type', async () => {
    const token = await signSession('gh:1', SIGNING_KEY);
    const res = await app.request(
      '/v1/publish',
      {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...validBody, type: 'unknown' }),
      },
      baseEnv(userLookupDB({ id: 'gh:1', github_login: 'me', avatar_url: null })),
    );
    expect(res.status).toBe(400);
  });

  it('returns 503 with a setup hint when ADMIN_* env vars are missing', async () => {
    const token = await signSession('gh:1', SIGNING_KEY);
    const res = await app.request(
      '/v1/publish',
      {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(validBody),
      },
      baseEnv(userLookupDB({ id: 'gh:1', github_login: 'me', avatar_url: null })),
    );
    expect(res.status).toBe(503);
    const body = (await res.json()) as { error: string; hint: string };
    expect(body.error).toBe('admin_provision_not_configured');
    expect(body.hint).toMatch(/CF dashboard/);
  });

  it('proxies to admin /api/provision with the requester github login', async () => {
    const token = await signSession('gh:1', SIGNING_KEY);
    const fetchSpy = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ steps: [] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );
    globalThis.fetch = fetchSpy;
    const res = await app.request(
      '/v1/publish',
      {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(validBody),
      },
      baseEnv(userLookupDB({ id: 'gh:1', github_login: 'me', avatar_url: null }), {
        ADMIN_API_BASE: 'https://admin.example',
        ADMIN_CF_ACCESS_CLIENT_ID: 'access-id',
        ADMIN_CF_ACCESS_CLIENT_SECRET: 'access-secret',
      }),
    );
    expect(res.status).toBe(200);

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [url, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://admin.example/api/provision');
    const headers = init.headers as Record<string, string>;
    expect(headers['CF-Access-Client-Id']).toBe('access-id');
    expect(headers['CF-Access-Client-Secret']).toBe('access-secret');
    const sentBody = JSON.parse(init.body as string);
    expect(sentBody.id).toBe('my-app');
    expect(sentBody.githubLogin).toBe('me');
    expect(sentBody.store).toBe('apps');
    expect(sentBody.type).toBe('standalone');

    const respBody = (await res.json()) as { appId: string; appUrl: string; repoUrl: string };
    expect(respBody.appId).toBe('my-app');
    expect(respBody.appUrl).toBe('https://my-app.freeappstore.online');
    expect(respBody.repoUrl).toBe('https://github.com/freeappstore-online/my-app');
  });

  it('returns 502 when admin /api/provision returns 5xx', async () => {
    const token = await signSession('gh:1', SIGNING_KEY);
    globalThis.fetch = vi.fn().mockResolvedValue(new Response('upstream boom', { status: 500 }));
    const res = await app.request(
      '/v1/publish',
      {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(validBody),
      },
      baseEnv(userLookupDB({ id: 'gh:1', github_login: 'me', avatar_url: null }), {
        ADMIN_API_BASE: 'https://admin.example',
        ADMIN_CF_ACCESS_CLIENT_ID: 'access-id',
        ADMIN_CF_ACCESS_CLIENT_SECRET: 'access-secret',
      }),
    );
    expect(res.status).toBe(502);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe('admin_provision_failed');
  });
});
