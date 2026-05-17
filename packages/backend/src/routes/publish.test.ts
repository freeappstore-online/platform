import { describe, expect, it } from 'vitest';
import { app } from '../index.js';
import { signSession } from '../lib/session.js';
import type { Env } from '../types.js';

const SIGNING_KEY = 'a'.repeat(64);

interface InsertCapture {
  sql: string;
  binds: unknown[];
}

function userLookupDB(
  user: { id: string; github_login: string; avatar_url: string | null } | null,
  inserts?: InsertCapture[],
): D1Database {
  const prepare = (sql: string): D1PreparedStatement => {
    const trimmed = sql.replace(/\s+/g, ' ').trim();
    let bound: unknown[] = [];
    const stmt: Partial<D1PreparedStatement> = {
      bind: (...args: unknown[]) => {
        bound = args;
        return stmt as D1PreparedStatement;
      },
      first: async <T>() => {
        if (trimmed.startsWith('SELECT id, github_login')) {
          return (user ?? null) as T | null;
        }
        return null;
      },
      run: async <T>() => {
        inserts?.push({ sql: trimmed, binds: bound });
        return { meta: { changes: 1 } } as unknown as D1Result<T>;
      },
    };
    return stmt as D1PreparedStatement;
  };
  return { prepare } as unknown as D1Database;
}

interface AdminCall {
  url: string;
  init: RequestInit;
}

/** Fake service-binding Fetcher — captures the call + returns a canned response. */
function fakeAdmin(opts: { response: Response; capture?: AdminCall[] }): Fetcher {
  return {
    fetch: async (input: string | URL | Request, init?: RequestInit) => {
      opts.capture?.push({
        url: typeof input === 'string' ? input : input.toString(),
        init: init ?? {},
      });
      return opts.response;
    },
  } as unknown as Fetcher;
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

  it('returns 503 with a setup hint when ADMIN binding is missing', async () => {
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
    expect(body.error).toBe('admin_binding_not_configured');
    expect(body.hint).toMatch(/wrangler\.toml/);
  });

  it('proxies to admin via service binding with the requester github login', async () => {
    const token = await signSession('gh:1', SIGNING_KEY);
    const calls: AdminCall[] = [];
    const admin = fakeAdmin({
      response: new Response(JSON.stringify({ steps: [], success: true }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
      capture: calls,
    });
    const res = await app.request(
      '/v1/publish',
      {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(validBody),
      },
      baseEnv(userLookupDB({ id: 'gh:1', github_login: 'me', avatar_url: null }), { ADMIN: admin }),
    );
    expect(res.status).toBe(200);

    expect(calls).toHaveLength(1);
    const call = calls[0]!;
    expect(call.url).toMatch(/\/api\/provision$/);
    const sentBody = JSON.parse(call.init.body as string);
    expect(sentBody.id).toBe('my-app');
    expect(sentBody.githubLogin).toBe('me');
    expect(sentBody.store).toBe('apps');
    expect(sentBody.type).toBe('standalone');
    // No CF-Access-* headers — service binding bypasses the gate.
    const headers = call.init.headers as Record<string, string>;
    expect(headers['CF-Access-Client-Id']).toBeUndefined();
    expect(headers['CF-Access-Client-Secret']).toBeUndefined();

    const respBody = (await res.json()) as { appId: string; appUrl: string; repoUrl: string };
    expect(respBody.appId).toBe('my-app');
    expect(respBody.appUrl).toBe('https://my-app.freeappstore.online');
    expect(respBody.repoUrl).toBe('https://github.com/freeappstore-online/my-app');
  });

  it('records ownership in the apps table after successful provision', async () => {
    const token = await signSession('gh:1', SIGNING_KEY);
    const inserts: InsertCapture[] = [];
    const admin = fakeAdmin({
      response: new Response(JSON.stringify({ steps: [], success: true }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    });
    const res = await app.request(
      '/v1/publish',
      {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(validBody),
      },
      baseEnv(userLookupDB({ id: 'gh:1', github_login: 'me', avatar_url: null }, inserts), {
        ADMIN: admin,
      }),
    );
    expect(res.status).toBe(200);

    const appInsert = inserts.find((i) => i.sql.startsWith('INSERT OR IGNORE INTO apps'));
    expect(appInsert).toBeDefined();
    // Order matches the SQL: id, owner_login, created_at, category, type, oneliner, repo, demo
    expect(appInsert!.binds[0]).toBe('my-app');
    expect(appInsert!.binds[1]).toBe('me');
    expect(typeof appInsert!.binds[2]).toBe('number');
    expect(appInsert!.binds[3]).toBe('Productivity');
    expect(appInsert!.binds[4]).toBe('standalone');
    expect(appInsert!.binds[5]).toBe('A simple test');
    expect(appInsert!.binds[6]).toBe('https://github.com/me/my-app');
    expect(appInsert!.binds[7]).toBeNull();
  });

  it('returns 502 when admin returns 5xx', async () => {
    const token = await signSession('gh:1', SIGNING_KEY);
    const admin = fakeAdmin({ response: new Response('upstream boom', { status: 500 }) });
    const res = await app.request(
      '/v1/publish',
      {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(validBody),
      },
      baseEnv(userLookupDB({ id: 'gh:1', github_login: 'me', avatar_url: null }), { ADMIN: admin }),
    );
    expect(res.status).toBe(502);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe('admin_provision_failed');
  });
});
