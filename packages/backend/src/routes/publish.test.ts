import { describe, expect, it } from 'vitest';
import { app } from '../index.js';
import { RESERVED_APP_IDS } from '../lib/reserved-app-ids.js';
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
  /** `users` rows matching the creatorGithub an admin attributes an app to. */
  creatorRows: Array<{ id: string }> = [],
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
      all: async <T>() => ({ results: creatorRows as unknown as T[] }) as D1Result<T>,
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
    const token = await signSession('gh:1', SIGNING_KEY, { aud: 'console' });
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

  it.each([...RESERVED_APP_IDS, 'template-standalone', 'template-x'])(
    'rejects the reserved name %s without calling admin (#9, #515)',
    async (name) => {
      const token = await signSession('gh:1', SIGNING_KEY, { aud: 'console' });
      const calls: AdminCall[] = [];
      const admin = fakeAdmin({ response: new Response('{}', { status: 200 }), capture: calls });
      const res = await app.request(
        '/v1/publish',
        {
          method: 'POST',
          headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ ...validBody, name }),
        },
        baseEnv(userLookupDB({ id: 'gh:1', github_login: 'me', avatar_url: null }), {
          ADMIN: admin,
        }),
      );
      expect(res.status).toBe(400);
      expect(await res.text()).toContain('reserved');
      expect(calls).toHaveLength(0);
    },
  );

  it('returns 400 for invalid type', async () => {
    const token = await signSession('gh:1', SIGNING_KEY, { aud: 'console' });
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
    const token = await signSession('gh:1', SIGNING_KEY, { aud: 'console' });
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
    const token = await signSession('gh:1', SIGNING_KEY, { aud: 'console' });
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
    expect((respBody as { repoEmpty?: boolean }).repoEmpty).toBe(false);
  });

  it('reports repoEmpty when admin says the repo has no commits (#547)', async () => {
    const token = await signSession('gh:1', SIGNING_KEY, { aud: 'console' });
    const admin = fakeAdmin({
      response: new Response(JSON.stringify({ steps: [], success: true, repoEmpty: true }), {
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
      baseEnv(userLookupDB({ id: 'gh:1', github_login: 'me', avatar_url: null }), { ADMIN: admin }),
    );
    expect(((await res.json()) as { repoEmpty: boolean }).repoEmpty).toBe(true);
  });

  it('forwards the full ownership payload to admin (which writes the apps row atomically)', async () => {
    const token = await signSession('gh:1', SIGNING_KEY, { aud: 'console' });
    const inserts: InsertCapture[] = [];
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
      baseEnv(userLookupDB({ id: 'gh:1', github_login: 'me', avatar_url: null }, inserts), {
        ADMIN: admin,
      }),
    );
    expect(res.status).toBe(200);

    // The backend is a pure proxy now — it must NOT write the apps row itself
    // (that was the drift source). The admin worker owns the write, so every
    // field it needs to build that row has to be forwarded.
    expect(inserts.some((i) => i.sql.startsWith('INSERT OR IGNORE INTO apps'))).toBe(false);
    const sentBody = JSON.parse(calls[0]!.init.body as string);
    expect(sentBody.id).toBe('my-app');
    expect(sentBody.creatorGithub).toBe('me');
    expect(sentBody.category).toBe('Productivity');
    expect(sentBody.type).toBe('standalone');
    expect(sentBody.description).toBe('A simple test'); // oneliner → apps.oneliner
    // apps.repo is derived by admin (#546); the client's repo is never forwarded.
    expect(sentBody.repo).toBeUndefined();
    expect(sentBody.demo).toBeNull();
    expect(sentBody.crossOriginIsolated).toBeUndefined();
  });

  it('forwards crossOriginIsolated to admin when the client opts in', async () => {
    const token = await signSession('gh:1', SIGNING_KEY, { aud: 'console' });
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
        body: JSON.stringify({ ...validBody, crossOriginIsolated: true }),
      },
      baseEnv(userLookupDB({ id: 'gh:1', github_login: 'me', avatar_url: null }), {
        ADMIN: admin,
      }),
    );
    expect(res.status).toBe(200);
    expect(JSON.parse(calls[0]!.init.body as string).crossOriginIsolated).toBe(true);
  });

  it('lets an admin attribute the app to a different creator (contributor onboarding)', async () => {
    const token = await signSession('gh:1', SIGNING_KEY, { aud: 'console' });
    const calls: AdminCall[] = [];
    const inserts: InsertCapture[] = [];
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
        body: JSON.stringify({ ...validBody, creatorGithub: 'abid8195' }),
      },
      baseEnv(
        userLookupDB({ id: 'gh:1', github_login: 'me', avatar_url: null }, inserts, [
          { id: 'gh:8195' },
        ]),
        { ADMIN: admin, ADMIN_GITHUB_LOGINS: 'me' },
      ),
    );
    expect(res.status).toBe(200);
    // The contributor is forwarded as creatorGithub — the admin worker credits
    // them in BOTH the registry entry and the D1 `apps.owner_login` row (which
    // it writes atomically with the route). The backend writes no apps row.
    const sentBody = JSON.parse(calls[0]!.init.body as string);
    expect(sentBody.creatorGithub).toBe('abid8195');
    expect(sentBody.githubLogin).toBe('abid8195');
    // ...and bound to their immutable account id, not just the mutable login (#566).
    expect(sentBody.creatorId).toBe('gh:8195');
    expect(inserts.some((i) => i.sql.startsWith('INSERT OR IGNORE INTO apps'))).toBe(false);
  });

  it('refuses a non-GitHub account whose login matches an admin (no provisioning)', async () => {
    // Email sign-in stores the email local-part in github_login, so
    // serge-ivo@attacker.example lands with github_login 'serge-ivo'.
    const emailUserId = `em:${'0'.repeat(32)}`;
    const token = await signSession(emailUserId, SIGNING_KEY, { aud: 'console' });
    const calls: AdminCall[] = [];
    const admin = fakeAdmin({ response: new Response('{}', { status: 200 }), capture: calls });
    const res = await app.request(
      '/v1/publish',
      {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...validBody, creatorGithub: 'victim' }),
      },
      baseEnv(
        userLookupDB({
          id: emailUserId,
          github_login: 'serge-ivo',
          avatar_url: null,
        }),
        { ADMIN: admin, ADMIN_GITHUB_LOGINS: 'serge-ivo' },
      ),
    );
    expect(res.status).toBe(403);
    expect(calls).toHaveLength(0);
  });

  it('forbids a non-admin from attributing the app to someone else', async () => {
    const token = await signSession('gh:1', SIGNING_KEY, { aud: 'console' });
    const res = await app.request(
      '/v1/publish',
      {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...validBody, creatorGithub: 'someone-else' }),
      },
      baseEnv(userLookupDB({ id: 'gh:1', github_login: 'me', avatar_url: null }), {
        ADMIN_GITHUB_LOGINS: '', // caller is not an admin
      }),
    );
    expect(res.status).toBe(403);
  });

  it('treats creatorGithub as the caller when it only differs by case (#442)', async () => {
    const token = await signSession('gh:1', SIGNING_KEY, { aud: 'console' });
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
        body: JSON.stringify({ ...validBody, creatorGithub: 'ME' }),
      },
      baseEnv(userLookupDB({ id: 'gh:1', github_login: 'me', avatar_url: null }), {
        ADMIN: admin,
        ADMIN_GITHUB_LOGINS: '', // caller is not an admin
      }),
    );
    expect(res.status).toBe(200);
    const sentBody = JSON.parse(calls[0]!.init.body as string);
    expect(sentBody.creatorGithub).toBe('me');
  });

  it('returns 400 for an invalid creatorGithub (admin)', async () => {
    const token = await signSession('gh:1', SIGNING_KEY, { aud: 'console' });
    const res = await app.request(
      '/v1/publish',
      {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...validBody, creatorGithub: 'bad login!' }),
      },
      baseEnv(userLookupDB({ id: 'gh:1', github_login: 'me', avatar_url: null }), {
        ADMIN_GITHUB_LOGINS: 'me',
      }),
    );
    expect(res.status).toBe(400);
  });

  it('returns 502 when admin returns 5xx', async () => {
    const token = await signSession('gh:1', SIGNING_KEY, { aud: 'console' });
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

  it('reports the failed steps when admin answers 400 for a failed step (#594)', async () => {
    const token = await signSession('gh:1', SIGNING_KEY, { aud: 'console' });
    const partialResult = {
      steps: [
        { name: 'GitHub repo', status: 'ok', detail: 'created' },
        { name: 'Hosting route', status: 'fail', detail: 'D1 error' },
        { name: 'Store registry', status: 'skip', detail: 'hosting failed' },
      ],
      success: false,
    };
    const admin = fakeAdmin({
      response: new Response(JSON.stringify(partialResult), {
        status: 400,
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
      baseEnv(userLookupDB({ id: 'gh:1', github_login: 'me', avatar_url: null }), { ADMIN: admin }),
    );
    expect(res.status).toBe(502);
    const body = (await res.json()) as {
      error: string;
      hint: string;
      failedSteps: Array<{ name: string }>;
    };
    expect(body.hint).toBe('Hosting route: D1 error');
    expect(body.error).toBe('admin_provision_partial_failure');
    expect(body.failedSteps).toHaveLength(1);
    expect(body.failedSteps[0]!.name).toBe('Hosting route');
  });

  it('returns 400 for missing required fields', async () => {
    const token = await signSession('gh:1', SIGNING_KEY, { aud: 'console' });
    const res = await app.request(
      '/v1/publish',
      {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'my-app' }),
      },
      baseEnv(userLookupDB({ id: 'gh:1', github_login: 'me', avatar_url: null })),
    );
    expect(res.status).toBe(400);
  });

  it('returns 400 for invalid store value', async () => {
    const token = await signSession('gh:1', SIGNING_KEY, { aud: 'console' });
    const res = await app.request(
      '/v1/publish',
      {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...validBody, store: 'nope' }),
      },
      baseEnv(userLookupDB({ id: 'gh:1', github_login: 'me', avatar_url: null })),
    );
    expect(res.status).toBe(400);
  });

  it('returns 410 with redirect hint for store=games (FGS moved to its own admin)', async () => {
    const token = await signSession('gh:1', SIGNING_KEY, { aud: 'console' });
    const res = await app.request(
      '/v1/publish',
      {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...validBody, store: 'games' }),
      },
      baseEnv(userLookupDB({ id: 'gh:1', github_login: 'me', avatar_url: null })),
    );
    expect(res.status).toBe(410);
    const body = (await res.json()) as { error: string; hint: string };
    expect(body.error).toBe('wrong_store');
    expect(body.hint).toContain('admin.freegamestore.online');
  });

  it('returns 410 for store=apps_pro (PAS has its own admin)', async () => {
    const token = await signSession('gh:1', SIGNING_KEY, { aud: 'console' });
    const res = await app.request(
      '/v1/publish',
      {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...validBody, store: 'apps_pro' }),
      },
      baseEnv(userLookupDB({ id: 'gh:1', github_login: 'me', avatar_url: null })),
    );
    expect(res.status).toBe(410);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe('wrong_store');
  });
});

/**
 * DB mock for the unpublish path: resolves the session user (SELECT id,
 * github_login) AND the app-ownership lookup (SELECT owner_id FROM apps).
 * ownerLogin=null means the app row doesn't exist.
 */
function unpublishDB(
  user: { id: string; github_login: string; avatar_url: string | null } | null,
  ownerLogin: string | null,
): D1Database {
  const prepare = (sql: string): D1PreparedStatement => {
    const trimmed = sql.replace(/\s+/g, ' ').trim();
    const stmt: Partial<D1PreparedStatement> = {
      bind: () => stmt as D1PreparedStatement,
      first: async <T>() => {
        if (trimmed.startsWith('SELECT id, github_login')) return (user ?? null) as T | null;
        if (trimmed.startsWith('SELECT owner_id FROM apps')) {
          return (
            ownerLogin
              ? { owner_id: ownerLogin === user?.github_login ? user.id : 'gh:other' }
              : null
          ) as T | null;
        }
        return null;
      },
    };
    return stmt as D1PreparedStatement;
  };
  return { prepare } as unknown as D1Database;
}

describe('POST /v1/unpublish', () => {
  it('returns 401 with no auth', async () => {
    const res = await app.request(
      '/v1/unpublish',
      { method: 'POST', body: JSON.stringify({ id: 'my-app' }) },
      baseEnv(unpublishDB(null, null)),
    );
    expect(res.status).toBe(401);
  });

  it('returns 400 for an invalid app id', async () => {
    const token = await signSession('gh:1', SIGNING_KEY, { aud: 'console' });
    const res = await app.request(
      '/v1/unpublish',
      {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: 'Bad Id!' }),
      },
      baseEnv(unpublishDB({ id: 'gh:1', github_login: 'me', avatar_url: null }, null)),
    );
    expect(res.status).toBe(400);
  });

  it('returns 404 when the app does not exist', async () => {
    const token = await signSession('gh:1', SIGNING_KEY, { aud: 'console' });
    const res = await app.request(
      '/v1/unpublish',
      {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: 'ghost-app' }),
      },
      baseEnv(unpublishDB({ id: 'gh:1', github_login: 'me', avatar_url: null }, null)),
    );
    expect(res.status).toBe(404);
  });

  it('returns 403 when the caller is neither owner nor admin', async () => {
    const token = await signSession('gh:1', SIGNING_KEY, { aud: 'console' });
    const res = await app.request(
      '/v1/unpublish',
      {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: 'someone-elses-app' }),
      },
      baseEnv(unpublishDB({ id: 'gh:1', github_login: 'me', avatar_url: null }, 'other-owner'), {
        ADMIN_GITHUB_LOGINS: '',
      }),
    );
    expect(res.status).toBe(403);
  });

  it('forwards owner unpublish to admin /api/deprovision with deleteRepo', async () => {
    const token = await signSession('gh:1', SIGNING_KEY, { aud: 'console' });
    const calls: AdminCall[] = [];
    const admin = fakeAdmin({
      response: new Response(JSON.stringify({ ok: true, steps: [] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
      capture: calls,
    });
    const res = await app.request(
      '/v1/unpublish',
      {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: 'my-app', deleteRepo: true }),
      },
      // caller 'me' owns the app
      baseEnv(unpublishDB({ id: 'gh:1', github_login: 'me', avatar_url: null }, 'me'), {
        ADMIN: admin,
      }),
    );
    expect(res.status).toBe(200);
    expect(calls).toHaveLength(1);
    const call = calls[0]!;
    expect(call.url).toMatch(/\/api\/deprovision$/);
    const sentBody = JSON.parse(call.init.body as string);
    expect(sentBody.id).toBe('my-app');
    expect(sentBody.store).toBe('apps');
    expect(sentBody.deleteRepo).toBe(true);
    // Service binding carries the shared token, not CF-Access headers.
    const headers = call.init.headers as Record<string, string>;
    expect(headers['X-Internal-Token']).toBeDefined();
  });

  it('lets a platform admin unpublish an app they do not own', async () => {
    const token = await signSession('gh:1', SIGNING_KEY, { aud: 'console' });
    const admin = fakeAdmin({
      response: new Response(JSON.stringify({ ok: true, steps: [] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    });
    const res = await app.request(
      '/v1/unpublish',
      {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: 'someone-elses-app' }),
      },
      baseEnv(unpublishDB({ id: 'gh:1', github_login: 'me', avatar_url: null }, 'other-owner'), {
        ADMIN: admin,
        ADMIN_GITHUB_LOGINS: 'me',
      }),
    );
    expect(res.status).toBe(200);
  });

  it('lets an admin listed by ADMIN_USER_IDS unpublish an app they do not own (#442)', async () => {
    const token = await signSession('gh:1', SIGNING_KEY, { aud: 'console' });
    const admin = fakeAdmin({
      response: new Response(JSON.stringify({ ok: true, steps: [] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    });
    const res = await app.request(
      '/v1/unpublish',
      {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: 'someone-elses-app' }),
      },
      baseEnv(unpublishDB({ id: 'gh:1', github_login: 'me', avatar_url: null }, 'other-owner'), {
        ADMIN: admin,
        ADMIN_GITHUB_LOGINS: '',
        ADMIN_USER_IDS: 'gh:1',
      }),
    );
    expect(res.status).toBe(200);
  });
});
