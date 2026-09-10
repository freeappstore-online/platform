import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { app } from '../index.js';
import type { Env } from '../types.js';

const SIGNING_KEY = 'a'.repeat(64);

interface FakeWrite {
  sql: string;
  args: unknown[];
}

function fakeDB(opts: { onUserUpsert?: (row: FakeWrite) => void } = {}): D1Database {
  const prepare = (sql: string): D1PreparedStatement => {
    const trimmed = sql.replace(/\s+/g, ' ').trim();
    let bound: unknown[] = [];
    const stmt: Partial<D1PreparedStatement> = {
      bind: (...args: unknown[]) => {
        bound = args;
        return stmt as D1PreparedStatement;
      },
      run: async <T = Record<string, unknown>>() => {
        if (trimmed.startsWith('INSERT INTO users')) {
          opts.onUserUpsert?.({ sql: trimmed, args: bound });
        }
        return { meta: { changes: 1 } } as unknown as D1Result<T>;
      },
      first: async <T = unknown>() => {
        if (trimmed.startsWith('SELECT date_of_birth FROM users')) {
          return { date_of_birth: null } as T;
        }
        return null as T;
      },
    };
    return stmt as D1PreparedStatement;
  };
  return { prepare } as unknown as D1Database;
}

const baseEnv = (db: D1Database, overrides: Partial<Env> = {}): Env =>
  ({
    DB: db,
    ROOM: {} as DurableObjectNamespace,
    GITHUB_CLIENT_ID: 'cid',
    GITHUB_CLIENT_SECRET: 'csec',
    SESSION_SIGNING_KEY: SIGNING_KEY,
    ...overrides,
  }) as Env;

/** The check-token 200 body: GitHub echoes the token's owner under `user`. */
const introspection = (user: Record<string, unknown>) =>
  new Response(JSON.stringify({ user }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });

function post(body: unknown, env: Env) {
  return app.request(
    '/v1/auth/exchange',
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: typeof body === 'string' ? body : JSON.stringify(body),
    },
    env,
  );
}

describe('POST /v1/auth/exchange', () => {
  let originalFetch: typeof fetch;
  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it('returns 400 when the body is not JSON', async () => {
    const res = await app.request(
      '/v1/auth/exchange',
      { method: 'POST', body: 'not json' },
      baseEnv(fakeDB()),
    );
    expect(res.status).toBe(400);
  });

  it('returns 400 when githubToken is missing', async () => {
    const res = await post({}, baseEnv(fakeDB()));
    expect(res.status).toBe(400);
  });

  it('returns 401 when GitHub rejects the token', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(new Response('', { status: 401 }));
    const res = await post({ githubToken: 'gho_bogus' }, baseEnv(fakeDB()));
    expect(res.status).toBe(401);
  });

  it('returns 502 when GitHub is unreachable / 5xx', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(new Response('', { status: 503 }));
    const res = await post({ githubToken: 'gho_x' }, baseEnv(fakeDB()));
    // An outage must not masquerade as "your token is bad" — that would send
    // users off to re-authenticate over something entirely on GitHub's side.
    expect(res.status).toBe(502);
  });

  it('mints a session and upserts the user on a valid GitHub token', async () => {
    globalThis.fetch = vi
      .fn()
      .mockResolvedValue(
        introspection({ id: 12345, login: 'alice', avatar_url: 'https://avatars/alice' }),
      );
    const writes: FakeWrite[] = [];
    const res = await post(
      { githubToken: 'gho_real' },
      baseEnv(fakeDB({ onUserUpsert: (w) => writes.push(w) })),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      sessionToken: string;
      user: { id: string; login: string };
    };
    expect(body.sessionToken).toMatch(/\..+/); // base64url.body.signature shape
    expect(body.user).toEqual({
      id: 'gh:12345',
      login: 'alice',
      avatarUrl: 'https://avatars/alice',
      dateOfBirth: null,
    });
    expect(writes).toHaveLength(1);
    expect(writes[0]!.args).toEqual([
      'gh:12345',
      12345,
      'alice',
      'https://avatars/alice',
      expect.any(Number),
    ]);
  });

  // ── #47: the token must belong to THIS OAuth app ────────────────

  it('rejects a token that is valid but issued to another app (404 from check-token)', async () => {
    // This is the confused-deputy case: GET /user would have answered 200 for
    // this token and handed out a session for its owner.
    globalThis.fetch = vi.fn().mockResolvedValue(new Response('', { status: 404 }));
    const writes: FakeWrite[] = [];
    const res = await post(
      { githubToken: 'ghp_someones_pat' },
      baseEnv(fakeDB({ onUserUpsert: (w) => writes.push(w) })),
    );

    expect(res.status).toBe(401);
    expect(await res.text()).toContain('not issued to this application');
    // No session, and no user record conjured for someone who never authorized us.
    expect(writes).toHaveLength(0);
  });

  it('verifies via the app-authenticated check-token endpoint, not GET /user', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(introspection({ id: 1, login: 'alice', avatar_url: null }));
    globalThis.fetch = fetchMock;
    await post({ githubToken: 'gho_real' }, baseEnv(fakeDB()));

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(String(url)).toBe('https://api.github.com/applications/cid/token');
    expect(init.method).toBe('POST');
    // App credentials authenticate the *request*; the user's token is the
    // subject in the body, never the bearer.
    const headers = init.headers as Record<string, string>;
    expect(headers.Authorization).toBe(`Basic ${btoa('cid:csec')}`);
    expect(headers.Authorization).not.toContain('gho_real');
    expect(JSON.parse(String(init.body))).toEqual({ access_token: 'gho_real' });
  });

  it('returns 401 when check-token succeeds but carries no user', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({}), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );
    const res = await post({ githubToken: 'gho_weird' }, baseEnv(fakeDB()));
    expect(res.status).toBe(401);
  });

  it('returns 503 when the OAuth app credentials are unconfigured', async () => {
    const fetchMock = vi.fn();
    globalThis.fetch = fetchMock;
    const res = await post(
      { githubToken: 'gho_real' },
      baseEnv(fakeDB(), { GITHUB_CLIENT_SECRET: '' as unknown as string }),
    );

    expect(res.status).toBe(503);
    // Fail before calling GitHub — an unauthenticated check-token call would
    // 401 and be reported to the caller as a bad token.
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
