import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { app } from '../index.js';
import { signPayload } from '../lib/session.js';
import type { Env } from '../types.js';

const SIGNING_KEY = 'a'.repeat(64);
const VALID_RETURN_TO = 'https://demo.freeappstore.online/';

interface UpsertCapture {
  sql: string;
  args: unknown[];
}

function fakeDB(opts: { onUserUpsert?: (row: UpsertCapture) => void } = {}): D1Database {
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
    };
    return stmt as D1PreparedStatement;
  };
  return { prepare } as unknown as D1Database;
}

function makeEnv(overrides: Record<string, unknown> = {}, db?: D1Database): Env {
  const base: Record<string, unknown> = {
    DB: db ?? fakeDB(),
    ROOM: {} as DurableObjectNamespace,
    GITHUB_CLIENT_ID: 'cid',
    GITHUB_CLIENT_SECRET: 'csec',
    SESSION_SIGNING_KEY: SIGNING_KEY,
    RESEND_API_KEY: 'resend-test-key',
    EMAIL_FROM: 'FreeAppStore <auth@freeappstore.online>',
  };
  for (const [k, v] of Object.entries(overrides)) {
    if (v === undefined) delete base[k];
    else base[k] = v;
  }
  return base as unknown as Env;
}

describe('POST /v1/auth/email/start', () => {
  const originalFetch = globalThis.fetch;
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn().mockResolvedValue(new Response('{}', { status: 200 }));
    globalThis.fetch = fetchMock as typeof globalThis.fetch;
  });
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it('returns 503 when RESEND_API_KEY is unset', async () => {
    const res = await app.request(
      '/v1/auth/email/start',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: 'a@b.com', appId: 'demo', returnTo: VALID_RETURN_TO }),
      },
      makeEnv({ RESEND_API_KEY: undefined }),
    );
    expect(res.status).toBe(503);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('returns 503 when EMAIL_FROM is unset', async () => {
    const res = await app.request(
      '/v1/auth/email/start',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: 'a@b.com', appId: 'demo', returnTo: VALID_RETURN_TO }),
      },
      makeEnv({ EMAIL_FROM: undefined }),
    );
    expect(res.status).toBe(503);
  });

  it('returns 400 when email is missing', async () => {
    const res = await app.request(
      '/v1/auth/email/start',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ appId: 'demo', returnTo: VALID_RETURN_TO }),
      },
      makeEnv(),
    );
    expect(res.status).toBe(400);
  });

  it('returns 400 when email is malformed', async () => {
    const res = await app.request(
      '/v1/auth/email/start',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: 'not-an-email', appId: 'demo', returnTo: VALID_RETURN_TO }),
      },
      makeEnv(),
    );
    expect(res.status).toBe(400);
  });

  it('returns 400 when returnTo is not allowlisted', async () => {
    const res = await app.request(
      '/v1/auth/email/start',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          email: 'a@b.com',
          appId: 'demo',
          returnTo: 'https://attacker.example.com/',
        }),
      },
      makeEnv(),
    );
    expect(res.status).toBe(400);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('queues an email to Resend with magic-link callback URL', async () => {
    const res = await app.request(
      '/v1/auth/email/start',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          email: '  Alice@Example.COM ',
          appId: 'demo',
          returnTo: VALID_RETURN_TO,
        }),
      },
      makeEnv(),
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(fetchMock).toHaveBeenCalledTimes(1);

    const call = fetchMock.mock.calls[0]!;
    const [url, init] = call as [
      string,
      RequestInit & { body: string; headers: Record<string, string> },
    ];
    expect(url).toBe('https://api.resend.com/emails');
    expect(init.headers.Authorization).toBe('Bearer resend-test-key');
    const body = JSON.parse(init.body);
    expect(body.from).toBe('FreeAppStore <auth@freeappstore.online>');
    // Email normalized: trimmed + lowercased
    expect(body.to).toBe('alice@example.com');
    // Magic link contains a signed token pointing at the callback
    expect(body.text).toContain('/v1/auth/email/callback?token=');
    expect(body.html).toContain('/v1/auth/email/callback?token=');
  });

  it('does not leak whether the email is already registered', async () => {
    // Caller can't tell if the email is new vs existing — both paths return 200.
    const res = await app.request(
      '/v1/auth/email/start',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          email: 'random-unknown@example.com',
          appId: 'demo',
          returnTo: VALID_RETURN_TO,
        }),
      },
      makeEnv(),
    );
    expect(res.status).toBe(200);
  });
});

describe('GET /v1/auth/email/callback', () => {
  const now = Math.floor(Date.now() / 1000);

  async function makeToken(
    overrides: Partial<{
      email: string;
      appId: string;
      returnTo: string;
      exp: number;
    }> = {},
  ) {
    return await signPayload(
      {
        email: 'alice@example.com',
        appId: 'demo',
        returnTo: VALID_RETURN_TO,
        exp: now + 60,
        ...overrides,
      },
      SIGNING_KEY,
    );
  }

  it('returns 400 when token is missing', async () => {
    const res = await app.request('/v1/auth/email/callback', {}, makeEnv());
    expect(res.status).toBe(400);
  });

  it('returns 400 when token is malformed', async () => {
    const res = await app.request('/v1/auth/email/callback?token=not.a.valid.token', {}, makeEnv());
    expect(res.status).toBe(400);
  });

  it('returns 400 when token has expired', async () => {
    const token = await makeToken({ exp: now - 10 });
    const res = await app.request(
      `/v1/auth/email/callback?token=${encodeURIComponent(token)}`,
      {},
      makeEnv(),
    );
    expect(res.status).toBe(400);
  });

  it('returns 400 when returnTo is no longer allowlisted', async () => {
    const token = await makeToken({ returnTo: 'https://attacker.example.com/' });
    const res = await app.request(
      `/v1/auth/email/callback?token=${encodeURIComponent(token)}`,
      {},
      makeEnv(),
    );
    expect(res.status).toBe(400);
  });

  it('upserts user with provider=email and redirects with session in hash', async () => {
    const captured: UpsertCapture[] = [];
    const db = fakeDB({ onUserUpsert: (r) => captured.push(r) });
    const token = await makeToken({ email: 'alice@example.com' });

    const res = await app.request(
      `/v1/auth/email/callback?token=${encodeURIComponent(token)}`,
      { redirect: 'manual' },
      makeEnv({}, db),
    );

    expect(res.status).toBe(302);
    const location = res.headers.get('location') ?? '';
    expect(location.startsWith(VALID_RETURN_TO)).toBe(true);
    expect(location).toContain('#fas_session=');

    expect(captured).toHaveLength(1);
    const upsert = captured[0]!;
    expect(upsert.sql).toContain('INSERT INTO users');
    // Binding order: userId, login, created_at, provider_id, email, display_name
    expect(upsert.args[0]).toBe('email:alice@example.com');
    expect(upsert.args[1]).toBe('alice'); // login = local part
    expect(upsert.args[3]).toBe('alice@example.com'); // provider_id
    expect(upsert.args[4]).toBe('alice@example.com'); // email
    expect(upsert.args[5]).toBe('alice'); // display_name
  });
});
