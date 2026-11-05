import { beforeEach, describe, expect, it } from 'vitest';
import { app } from '../index.js';
import { signSession } from './session.js';
import { hasSqlite, type SqliteDb, sqliteD1 } from './sqlite-d1.testutil.js';

/**
 * #430: a session token lives 30 days with roles/appRoles baked in at sign-in.
 * Authorization must be decided from the env admin lists and the DB on every
 * request, so revoking access takes effect immediately.
 */
const KEY = 'a'.repeat(64);

describe.skipIf(!hasSqlite)('authorization ignores stale session-token claims', () => {
  let db: SqliteDb;
  let d1: D1Database;

  beforeEach(() => {
    ({ db, d1 } = sqliteD1());
    const user = db.prepare(
      'INSERT INTO users (id, github_id, github_login, avatar_url, created_at) VALUES (?, ?, ?, NULL, 0)',
    );
    user.run('gh:1', 1, 'alice');
    user.run('gh:2', 2, 'bob');
    db.prepare('INSERT INTO apps (id, owner_login, created_at) VALUES (?, ?, 0)').run(
      'timer',
      'Alice',
    );
  });

  const env = (extra: Record<string, unknown> = {}) => ({
    DB: d1,
    SESSION_SIGNING_KEY: KEY,
    ...extra,
  });

  /** A token minted while bob was an admin, moderator and (claimed) owner of timer. */
  const staleBob = () =>
    signSession('gh:2', KEY, {
      roles: ['user', 'creator', 'admin'],
      appRoles: { timer: ['owner', 'moderator'] },
    });

  const get = async (path: string, token: string, extra?: Record<string, unknown>) =>
    app.request(path, { headers: { Authorization: `Bearer ${token}` } }, env(extra));

  it('denies an admin route to a token claiming admin once the user is off the lists', async () => {
    const res = await get('/v1/admin/stats', await staleBob(), {
      ADMIN_GITHUB_LOGINS: 'alice',
      ADMIN_USER_IDS: 'gh:1',
    });
    expect(res.status).toBe(403);
  });

  it('still allows an admin who is on the list, whatever the token says', async () => {
    const plain = await signSession('gh:2', KEY);
    expect((await get('/v1/admin/stats', plain, { ADMIN_USER_IDS: 'gh:2' })).status).toBe(200);
    expect((await get('/v1/admin/stats', plain, { ADMIN_GITHUB_LOGINS: 'BOB' })).status).toBe(200);
  });

  it('/auth/me reports live roles, not the token snapshot', async () => {
    const res = await get('/v1/auth/me', await staleBob());
    expect(res.status).toBe(200);
    const me = (await res.json()) as { roles: string[]; appRoles: Record<string, string[]> };
    expect(me.roles).toEqual(['user']);
    expect(me.appRoles).toEqual({});

    const asAdmin = (await (
      await get('/v1/auth/me', await staleBob(), { ADMIN_USER_IDS: 'gh:2' })
    ).json()) as { roles: string[] };
    expect(asAdmin.roles).toContain('admin');
  });

  it('/auth/me reports owner and creator from apps.owner_login, case-insensitively', async () => {
    const me = (await (await get('/v1/auth/me', await signSession('gh:1', KEY))).json()) as {
      roles: string[];
      appRoles: Record<string, string[]>;
    };
    expect(me.roles).toEqual(['user', 'creator']);
    expect(me.appRoles).toEqual({ timer: ['owner'] });
  });

  it('roles/check answers from the DB, not token appRoles', async () => {
    const token = await staleBob();
    for (const role of ['moderator', 'owner']) {
      const res = await get(`/v1/apps/timer/roles/check/${role}`, token);
      expect(await res.json()).toMatchObject({ has: false });
    }
    db.prepare(
      "INSERT INTO app_roles (app_id, user_id, role_name) VALUES ('timer', 'gh:2', 'moderator')",
    ).run();
    const res = await get('/v1/apps/timer/roles/check/moderator', token);
    expect(await res.json()).toMatchObject({ has: true });
  });

  it('roles/check owner comes from apps.owner_login, case-insensitively', async () => {
    const res = await get('/v1/apps/timer/roles/check/owner', await signSession('gh:1', KEY));
    expect(await res.json()).toMatchObject({ has: true });
  });

  it('role management denies a token claiming admin/owner for a non-owner off the lists', async () => {
    const res = await get('/v1/apps/timer/roles', await staleBob());
    expect(res.status).toBe(403);
  });

  it('owner checks accept a mixed-case owner_login', async () => {
    const token = await signSession('gh:1', KEY);
    expect((await get('/v1/apps/timer/roles', token)).status).toBe(200);
    expect((await get('/v1/apps/timer/webhooks', token)).status).toBe(200);
    expect((await get('/v1/apps/timer/webhooks', await staleBob())).status).toBe(403);
    expect((await get('/v1/apps/ghost/webhooks', token)).status).toBe(404);
  });
});
