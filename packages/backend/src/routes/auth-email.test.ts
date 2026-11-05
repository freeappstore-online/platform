import { beforeEach, describe, expect, it, vi } from 'vitest';
import { app } from '../index.js';
import { signPayload, verifySession } from '../lib/session.js';
import { hasSqlite, sqliteD1 } from '../lib/sqlite-d1.testutil.js';
import type { Env } from '../types.js';

const SIGNING_KEY = 'a'.repeat(64);
const VALID_RETURN_TO = 'https://demo.freeappstore.online/';
let emailSend: ReturnType<typeof vi.fn>;

function fakeDB(): D1Database {
  const prepare = (): D1PreparedStatement => {
    const stmt: Partial<D1PreparedStatement> = {
      bind: () => stmt as D1PreparedStatement,
      run: async <T = Record<string, unknown>>() =>
        ({ meta: { changes: 1 } }) as unknown as D1Result<T>,
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
    EMAIL: { send: emailSend },
  };
  for (const [k, v] of Object.entries(overrides)) {
    if (v === undefined) delete base[k];
    else base[k] = v;
  }
  return base as unknown as Env;
}

describe('POST /v1/auth/email/start', () => {
  beforeEach(() => {
    emailSend = vi.fn().mockResolvedValue({ messageId: 'test-message-id' });
  });

  it('returns 503 when the Email Service binding is unset', async () => {
    const res = await app.request(
      '/v1/auth/email/start',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: 'a@b.com', appId: 'demo', returnTo: VALID_RETURN_TO }),
      },
      makeEnv({ EMAIL: undefined }),
    );
    expect(res.status).toBe(503);
    expect(emailSend).not.toHaveBeenCalled();
  });

  it.each(['{bad', 'null'])('returns 400 for a malformed body (%s)', async (body) => {
    const res = await app.request(
      '/v1/auth/email/start',
      { method: 'POST', headers: { 'Content-Type': 'application/json' }, body },
      makeEnv(),
    );
    expect(res.status).toBe(400);
    expect(emailSend).not.toHaveBeenCalled();
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
    expect(emailSend).not.toHaveBeenCalled();
  });

  it('queues an email through Cloudflare Email Service with a magic-link callback URL', async () => {
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
    expect(emailSend).toHaveBeenCalledTimes(1);

    const [body] = emailSend.mock.calls[0]!;
    expect(body.from).toEqual({ email: 'auth@freeappstore.online', name: 'FreeAppStore' });
    expect(body.replyTo).toBe('support@freeappstore.online');
    // Email normalized: trimmed + lowercased
    expect(body.to).toBe('alice@example.com');
    // Magic link contains a signed token pointing at the callback
    expect(body.text).toContain('/v1/auth/email/callback?token=');
    expect(body.html).toContain('/v1/auth/email/callback?token=');
  });

  it('does not apply the cooldown when Email Service rejects a send', async () => {
    emailSend.mockRejectedValueOnce(new Error('temporary provider failure'));
    const request = {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        email: 'retry@example.com',
        appId: 'demo',
        returnTo: VALID_RETURN_TO,
      }),
    };

    const first = await app.request('/v1/auth/email/start', request, makeEnv());
    expect(first.status).toBe(502);

    const second = await app.request('/v1/auth/email/start', request, makeEnv());
    expect(second.status).toBe(200);
    expect(emailSend).toHaveBeenCalledTimes(2);
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
});

describe.skipIf(!hasSqlite)('email sign-in user ids against real SQLite (#434)', () => {
  // Each link must differ, or the second is rejected as a replay.
  let exp = Math.floor(Date.now() / 1000) + 60;

  async function signIn(d1: D1Database, email: string): Promise<string> {
    const token = await signPayload(
      { email, appId: 'demo', returnTo: VALID_RETURN_TO, exp: exp++ },
      SIGNING_KEY,
    );
    const res = await app.request(
      `/v1/auth/email/callback?token=${encodeURIComponent(token)}`,
      { redirect: 'manual' },
      makeEnv({}, d1),
    );
    expect(res.status).toBe(302);
    const location = res.headers.get('location') ?? '';
    expect(location.startsWith(VALID_RETURN_TO)).toBe(true);
    const session = decodeURIComponent(location.split('#fas_session=')[1] ?? '');
    const payload = await verifySession(session, SIGNING_KEY);
    expect(payload).not.toBeNull();
    return payload!.uid;
  }

  it('mints an opaque id and a neutral name, neither derived from the address', async () => {
    const { db, d1 } = sqliteD1();
    const uid = await signIn(d1, 'alice@example.com');
    expect(uid).toMatch(/^em:[0-9a-f]{32}$/);
    const rows = db.prepare('SELECT * FROM users').all() as Record<string, unknown>[];
    expect(rows).toEqual([
      expect.objectContaining({
        id: uid,
        provider: 'email',
        provider_id: 'alice@example.com',
        email: 'alice@example.com',
        github_login: expect.stringMatching(/^user-[0-9a-f]{4}$/),
      }),
    ]);
    expect(rows[0]!.display_name).toBe(rows[0]!.github_login);
  });

  it('keeps the name an existing account already has', async () => {
    const { db, d1 } = sqliteD1();
    const uid = await signIn(d1, 'alice@example.com');
    db.prepare("UPDATE users SET display_name = 'Alice' WHERE id = ?").run(uid);
    await signIn(d1, 'alice@example.com');
    expect(db.prepare('SELECT display_name FROM users WHERE id = ?').get(uid)).toEqual({
      display_name: 'Alice',
    });
  });

  it('refuses an account that still has a retired email: id instead of minting it a session', async () => {
    const { db, d1 } = sqliteD1({ before: '0032_opaque_email_user_ids.sql' });
    db.prepare(
      `INSERT INTO users (id, github_id, github_login, created_at, provider, provider_id, email, display_name)
       VALUES ('email:alice@example.com', 0, 'alice', 1, 'email', 'alice@example.com', 'alice@example.com', 'alice')`,
    ).run();
    const token = await signPayload(
      { email: 'alice@example.com', appId: 'demo', returnTo: VALID_RETURN_TO, exp: exp++ },
      SIGNING_KEY,
    );
    const res = await app.request(
      `/v1/auth/email/callback?token=${encodeURIComponent(token)}`,
      { redirect: 'manual' },
      makeEnv({}, d1),
    );
    expect(res.status).toBe(401);
    expect(await res.text()).not.toContain('alice');
    expect(db.prepare('SELECT count(*) AS n FROM users').get()).toEqual({ n: 1 });
  });

  it('a second concurrent first sign-in for one address joins the row the first created', async () => {
    const { db, d1 } = sqliteD1();
    const first = await signIn(d1, 'carol@example.com');
    // Simulate the race: the lookup missed, then the insert hit the unique index.
    const raced = {
      prepare(sql: string) {
        const stmt = d1.prepare(sql);
        if (!sql.startsWith("SELECT id, github_login FROM users WHERE provider = 'email'"))
          return stmt;
        let calls = 0;
        return {
          bind: (...args: unknown[]) => {
            stmt.bind(...args);
            return {
              first: async () => (calls++ === 0 ? null : stmt.first()),
            };
          },
        };
      },
    } as unknown as D1Database;
    expect(await signIn(raced, 'carol@example.com')).toBe(first);
    expect(db.prepare('SELECT count(*) AS n FROM users').get()).toEqual({ n: 1 });
  });

  it('finds the same account on the next sign-in, and a new one for another address', async () => {
    const { db, d1 } = sqliteD1();
    const first = await signIn(d1, 'alice@example.com');
    expect(await signIn(d1, 'alice@example.com')).toBe(first);
    const other = await signIn(d1, 'bob@example.com');
    expect(other).not.toBe(first);
    expect(db.prepare('SELECT count(*) AS n FROM users').get()).toEqual({ n: 2 });
  });
});
