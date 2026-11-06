/**
 * The audience rules of #495, through real routes:
 *   - an app-data route (`/v1/apps/:appId/kv`) takes the app's own session or
 *     a first-party one, never another app's;
 *   - a console-only route (`/v1/publish`, `/v1/apps/mine`) takes only a
 *     first-party session;
 *   - a pre-#495 token (no `aud`) is `legacy`: app-data until the cutoff,
 *     never console-only;
 *   - `sessions_valid_after` revokes everything issued before it.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { app } from '../index.js';
import { LEGACY_AUD_CUTOFF } from './auth.js';
import { signPayload, signSession } from './session.js';

const KEY = 'a'.repeat(64);

function fakeDB(opts: { validAfter?: number } = {}): D1Database {
  const prepare = (sql: string) => {
    const trimmed = sql.replace(/\s+/g, ' ').trim();
    const stmt = {
      bind: () => stmt,
      first: async () => {
        if (trimmed.includes('FROM apps')) return { ok: 1 };
        if (trimmed.startsWith('SELECT id, github_login')) {
          return {
            id: 'gh:1',
            github_login: 'alice',
            avatar_url: null,
            display_name: null,
            email: null,
            date_of_birth: null,
            sessions_valid_after: opts.validAfter ?? 0,
          };
        }
        if (trimmed.includes('FROM kv WHERE')) {
          return { total: 0, keys: 0, key_exists: 0, existing: 0 };
        }
        return null;
      },
      all: async () => ({ results: [] }),
      run: async () => ({ meta: { changes: 1 } }),
    };
    return stmt;
  };
  return { prepare } as unknown as D1Database;
}

const env = (db = fakeDB()) => ({ DB: db, SESSION_SIGNING_KEY: KEY, ROOM: {} });

const legacyToken = () =>
  signPayload(
    {
      uid: 'gh:1',
      roles: ['user'],
      appRoles: {},
      iat: Math.floor(Date.now() / 1000),
      exp: Math.floor(Date.now() / 1000) + 60,
    },
    KEY,
  );

const kvGet = (token: string, appId = 'chess') =>
  app.request(`/v1/apps/${appId}/kv/k`, { headers: { Authorization: `Bearer ${token}` } }, env());

// `name: 'x'` fails the app-id rule, so a request that passes auth answers 400.
const publish = (token: string) =>
  app.request(
    '/v1/publish',
    { method: 'POST', headers: { Authorization: `Bearer ${token}` }, body: '{"name":"x"}' },
    env(),
  );

afterEach(() => vi.useRealTimers());

describe('requireAppUser', () => {
  it("accepts the app's own session and a console session", async () => {
    expect((await kvGet(await signSession('gh:1', KEY, { aud: 'chess' }))).status).toBe(200);
    expect((await kvGet(await signSession('gh:1', KEY, { aud: 'console' }))).status).toBe(200);
  });

  it("refuses another app's session with 403 wrong_audience", async () => {
    const res = await kvGet(await signSession('gh:1', KEY, { aud: 'notes' }));
    expect(res.status).toBe(403);
    expect(await res.text()).toContain('wrong_audience');
  });

  it('accepts a legacy token until the cutoff, then 401s it', async () => {
    const token = await legacyToken();
    expect((await kvGet(token)).status).toBe(200);

    vi.useFakeTimers();
    vi.setSystemTime(LEGACY_AUD_CUTOFF + 1000);
    const token2 = await legacyToken();
    const res = await kvGet(token2);
    expect(res.status).toBe(401);
    expect(await res.text()).toContain('session_reissue_required');
  });
});

describe('requireConsoleUser', () => {
  it('accepts a console session', async () => {
    // Past auth: the body fails validation — but not with 401/403.
    const res = await publish(await signSession('gh:1', KEY, { aud: 'console' }));
    expect(res.status).toBe(400);
  });

  it('refuses an app session with 403 console_session_required', async () => {
    const res = await publish(await signSession('gh:1', KEY, { aud: 'chess' }));
    expect(res.status).toBe(403);
    expect(await res.text()).toContain('console_session_required');
  });

  it('refuses a legacy token with 401 so the client re-signs in', async () => {
    const res = await publish(await legacyToken());
    expect(res.status).toBe(401);
    expect(await res.text()).toContain('session_reissue_required');
  });

  it('never grants console to a cross-store token that claims it', async () => {
    const emptyDB = fakeDB();
    (emptyDB as unknown as { prepare: unknown }).prepare = () => {
      const stmt = {
        bind: () => stmt,
        first: async () => null,
        all: async () => ({ results: [] }),
        run: async () => ({ meta: { changes: 0 } }),
      };
      return stmt;
    };
    const res = await app.request(
      '/v1/apps/mine',
      {
        headers: {
          Authorization: `Bearer ${await signSession('cred:pas', KEY, { aud: 'console' })}`,
        },
      },
      env(emptyDB),
    );
    expect(res.status).toBe(401);
  });
});

describe('revocation via sessions_valid_after', () => {
  it('401s a session issued before the mark and keeps a later one', async () => {
    const now = Math.floor(Date.now() / 1000);
    const token = await signSession('gh:1', KEY, { aud: 'console' });
    const revoked = await app.request(
      '/v1/auth/me',
      { headers: { Authorization: `Bearer ${token}` } },
      env(fakeDB({ validAfter: now + 10 })),
    );
    expect(revoked.status).toBe(401);
    expect(await revoked.text()).toContain('revoked');

    const fine = await app.request(
      '/v1/auth/me',
      { headers: { Authorization: `Bearer ${token}` } },
      env(fakeDB({ validAfter: now - 10 })),
    );
    expect(fine.status).toBe(200);
    expect(((await fine.json()) as { aud: string }).aud).toBe('console');
  });

  it('POST /v1/auth/logout moves the mark to now for the caller', async () => {
    const runs: Array<{ sql: string; args: unknown[] }> = [];
    const db = fakeDB();
    const inner = db.prepare.bind(db);
    (db as unknown as { prepare: unknown }).prepare = (sql: string) => {
      const stmt = inner(sql) as unknown as { bind: (...a: unknown[]) => unknown };
      return {
        ...stmt,
        bind: (...args: unknown[]) => {
          runs.push({ sql, args });
          return stmt.bind(...args);
        },
      };
    };
    const token = await signSession('gh:1', KEY, { aud: 'chess' });
    const res = await app.request(
      '/v1/auth/logout',
      { method: 'POST', headers: { Authorization: `Bearer ${token}` } },
      env(db),
    );
    expect(res.status).toBe(200);
    const update = runs.find((r) => r.sql.startsWith('UPDATE users SET sessions_valid_after'));
    expect(update?.args[1]).toBe('gh:1');
    expect(update?.args[0]).toBeGreaterThan(Math.floor(Date.now() / 1000) - 5);
  });
});
