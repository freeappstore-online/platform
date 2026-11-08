/**
 * The audience rules of #495, through every guarded route, against real
 * SQLite with every migration applied.
 *
 * Tokens for alice (gh:1, owner of `chess`, platform admin):
 *   app     — delivered to chess        (aud: chess)
 *   other   — delivered to another app  (aud: notes)
 *   console — first-party               (aud: console)
 *   legacy  — minted before #495        (no aud)
 *
 *   app-data route  → app ✓, console ✓, legacy ✓ (until the cutoff), other 403
 *   console route   → console ✓, app 403, other 403, legacy 401
 *
 * "✓" means the guard let it through: no 401, and no 403 except the proxy's
 * own "no allowlist match" (the handler may still answer 400/404/503 for the
 * empty request body or missing bindings — that is past auth, which is all
 * this file is about).
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { app } from '../index.js';
import { LEGACY_AUD_CUTOFF } from './auth.js';
import { signPayload, signSession } from './session.js';
import { hasSqlite, sqliteD1 } from './sqlite-d1.testutil.js';

const KEY = 'a'.repeat(64);

type Token = 'app' | 'other' | 'console' | 'legacy';
type Route = [method: string, path: string];

const APP_DATA: Route[] = [
  ['GET', '/v1/apps/chess/kv'],
  ['GET', '/v1/apps/chess/kv/k'],
  ['PUT', '/v1/apps/chess/kv/k'],
  ['DELETE', '/v1/apps/chess/kv/k'],
  ['POST', '/v1/apps/chess/db/posts'],
  ['PUT', '/v1/apps/chess/db/posts/d1'],
  ['DELETE', '/v1/apps/chess/db/posts/d1'],
  ['POST', '/v1/apps/chess/counters/likes'],
  ['POST', '/v1/apps/chess/rooms/r1/ticket'],
  ['GET', '/v1/apps/chess/roles'],
  ['POST', '/v1/apps/chess/roles/ensure-member'],
  ['GET', '/v1/apps/chess/roles/check/owner'],
  ['POST', '/v1/apps/chess/push/subscriptions'],
  ['GET', '/v1/apps/chess/push/schedules'],
  ['POST', '/v1/apps/chess/email/send'],
  ['POST', '/v1/apps/chess/logs'],
  ['POST', '/v1/apps/chess/data-rooms'],
  ['GET', '/v1/apps/chess/webhooks'],
  ['GET', '/v1/apps/chess/proxy/api.example.com/x'],
];

const CONSOLE_ONLY: Route[] = [
  ['POST', '/v1/publish'],
  ['POST', '/v1/unpublish'],
  ['GET', '/v1/apps/mine'],
  ['GET', '/v1/apps/deploy-status'],
  ['GET', '/v1/apps/chess/deploy-status'],
  ['GET', '/v1/agent/sessions'],
  ['POST', '/v1/audit/run'],
  ['GET', '/v1/apps/chess/analytics'],
  ['PUT', '/v1/apps/chess/analytics'],
  ['GET', '/v1/analytics/summary'],
  ['GET', '/v1/apps/chess/analytics/stats'],
  ['GET', '/v1/apps/chess/secrets'],
  ['PUT', '/v1/apps/chess/secrets/X'],
  ['DELETE', '/v1/apps/chess/secrets/X'],
  ['GET', '/v1/apps/chess/allowlist'],
  ['GET', '/v1/apps/chess/logs'],
  ['POST', '/v1/apps/chess/webhooks'],
  ['GET', '/v1/keys/usage'],
  ['PUT', '/v1/keys/openai'],
  ['DELETE', '/v1/keys/openai'],
  ['DELETE', '/v1/auth/me'],
  ['POST', '/v1/auth/logout'],
  ['GET', '/v1/admin/users'],
  ['POST', '/v1/store/apps/chess/vote'],
  ['POST', '/v1/store/ideas/i1/builder'],
];

function seededEnv() {
  const { db, d1 } = sqliteD1();
  const now = Date.now();
  db.exec(`INSERT INTO users (id, github_id, github_login, created_at) VALUES ('gh:1', 1, 'alice', ${now});
    INSERT INTO apps (id, owner_login, created_at) VALUES ('chess', 'alice', ${now});
    INSERT INTO apps (id, owner_login, created_at) VALUES ('notes', 'bob', ${now});`);
  return {
    db,
    env: {
      DB: d1,
      SESSION_SIGNING_KEY: KEY,
      APP_SECRET_KEK: 'k'.repeat(64),
      ADMIN_USER_IDS: 'gh:1',
      ROOM: {},
    },
  };
}

async function token(kind: Token): Promise<string> {
  if (kind === 'legacy') {
    const iat = Math.floor(Date.now() / 1000);
    return signPayload({ uid: 'gh:1', roles: ['user'], appRoles: {}, iat, exp: iat + 60 }, KEY);
  }
  return signSession('gh:1', KEY, {
    aud: { app: 'chess', other: 'notes', console: 'console' }[kind],
  });
}

async function call([method, path]: Route, kind: Token) {
  const { env } = seededEnv();
  const res = await app.request(
    path,
    {
      method,
      headers: { Authorization: `Bearer ${await token(kind)}`, 'Content-Type': 'application/json' },
      ...(method === 'GET' || method === 'DELETE' ? {} : { body: '{}' }),
    },
    env,
  );
  return { status: res.status, text: await res.text() };
}

const passedAuth = (r: { status: number; text: string }) =>
  r.status !== 401 && (r.status !== 403 || r.text.includes('no allowlist match'));

afterEach(() => vi.useRealTimers());

describe.skipIf(!hasSqlite)('route audience matrix (#495)', () => {
  describe.each(APP_DATA)('app-data %s %s', (method, path) => {
    it.each(['app', 'console', 'legacy'] as const)('lets a %s token through', async (kind) => {
      const r = await call([method, path], kind);
      expect(passedAuth(r), `${r.status} ${r.text}`).toBe(true);
    });

    it("refuses another app's token with 403 wrong_audience", async () => {
      const r = await call([method, path], 'other');
      expect(r.status).toBe(403);
      expect(r.text).toContain('wrong_audience');
    });
  });

  describe.each(CONSOLE_ONLY)('console-only %s %s', (method, path) => {
    it('lets a console token through', async () => {
      const r = await call([method, path], 'console');
      expect(passedAuth(r), `${r.status} ${r.text}`).toBe(true);
    });

    it.each(['app', 'other'] as const)('refuses a %s token with 403', async (kind) => {
      const r = await call([method, path], kind);
      expect(r.status).toBe(403);
      expect(r.text).toContain('console_session_required');
    });

    it('refuses a legacy token with 401 so the client signs in again', async () => {
      const r = await call([method, path], 'legacy');
      expect(r.status).toBe(401);
      expect(r.text).toContain('session_reissue_required');
    });
  });

  it('refuses a legacy token on app-data routes after the cutoff', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(LEGACY_AUD_CUTOFF + 1000);
    const r = await call(['GET', '/v1/apps/chess/kv'], 'legacy');
    expect(r.status).toBe(401);
    expect(r.text).toContain('session_reissue_required');
  });
});

describe.skipIf(!hasSqlite)('cross-store and revocation (#495)', () => {
  it('maps a cross-store token claiming console to an audience that matches nothing', async () => {
    const { env } = seededEnv();
    const cred = await signSession('cred:pas', KEY, { aud: 'console' });
    for (const path of ['/v1/apps/mine', '/v1/apps/chess/kv']) {
      const res = await app.request(path, { headers: { Authorization: `Bearer ${cred}` } }, env);
      expect(res.status).toBe(403);
    }
  });

  it('POST /v1/auth/logout revokes every earlier session, in every app', async () => {
    const { db, env } = seededEnv();
    const appToken = await signSession('gh:1', KEY, { aud: 'chess' });
    const consoleToken = await signSession('gh:1', KEY, { aud: 'console' });
    const me = (t: string) =>
      app.request('/v1/auth/me', { headers: { Authorization: `Bearer ${t}` } }, env);
    expect((await me(appToken)).status).toBe(200);

    const out = await app.request(
      '/v1/auth/logout',
      { method: 'POST', headers: { Authorization: `Bearer ${consoleToken}` } },
      env,
    );
    expect(out.status).toBe(200);
    // Tokens signed in the same second as the logout are revoked too (iat <= mark).

    const revoked = await me(appToken);
    expect(revoked.status).toBe(401);
    expect(await revoked.text()).toContain('revoked');
    expect((await me(consoleToken)).status).toBe(401);
  });

  it("an account deleted and signed up again does not revive the old account's tokens", async () => {
    const { db, env } = seededEnv();
    const old = await signSession('gh:1', KEY, { aud: 'chess' });
    db.exec("DELETE FROM users WHERE id = 'gh:1'");
    // The new row, as every sign-in insert writes it: marked at its creation.
    const later = Math.floor(Date.now() / 1000) + 1;
    db.exec(
      `INSERT INTO users (id, github_id, github_login, created_at, sessions_valid_after) VALUES ('gh:1', 1, 'alice', 0, ${later})`,
    );
    const res = await app.request(
      '/v1/auth/me',
      { headers: { Authorization: `Bearer ${old}` } },
      env,
    );
    expect(res.status).toBe(401);
  });

  it('serves the quality badge with a sandboxing CSP', async () => {
    const { env } = seededEnv();
    const res = await app.request(
      '/v1/apps/chess/quality/badge',
      {},
      {
        ...env,
        APPS_BUCKET: { get: async () => ({ text: async () => '<svg><script>1</script></svg>' }) },
      },
    );
    expect(res.status).toBe(200);
    expect(res.headers.get('content-security-policy')).toBe(
      "default-src 'none'; style-src 'unsafe-inline'; sandbox",
    );
  });
});
