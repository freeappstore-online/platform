import { describe, expect, it } from 'vitest';
import { app } from '../index.js';
import { computeRoles } from '../routes/auth.js';
import { isAdminLogin, isAppOwner } from './auth.js';
import { signSession } from './session.js';
import { hasSqlite, migration, sqliteD1 } from './sqlite-d1.testutil.js';

/**
 * #566: app ownership is the immutable `gh:<id>`, not the GitHub username, which
 * is mutable and can be re-registered by someone else after a rename.
 * #571: PAS rows (store = 'apps_pro') in the shared table don't count as FAS apps.
 */
const KEY = 'a'.repeat(64);

describe('isAppOwner', () => {
  it('compares the account id, never a login', () => {
    expect(isAppOwner({ id: 'gh:1' }, 'gh:1')).toBe(true);
    expect(isAppOwner({ id: 'gh:2' }, 'gh:1')).toBe(false);
    expect(isAppOwner({ id: 'gh:1' }, null)).toBe(false);
  });
});

describe('isAdminLogin (transitional)', () => {
  it('applies until ADMIN_USER_IDS carries a gh: id, then yields to ids only', () => {
    const logins = { ADMIN_GITHUB_LOGINS: 'root' } as never;
    expect(isAdminLogin('root', logins)).toBe(true);
    const withGoogleOnly = { ADMIN_GITHUB_LOGINS: 'root', ADMIN_USER_IDS: 'google:9' } as never;
    expect(isAdminLogin('root', withGoogleOnly)).toBe(true);
    const withGh = { ADMIN_GITHUB_LOGINS: 'root', ADMIN_USER_IDS: 'gh:5' } as never;
    expect(isAdminLogin('root', withGh)).toBe(false);
  });
});

describe.skipIf(!hasSqlite)('ownership by immutable id against real SQLite', () => {
  function setup() {
    const { db, d1 } = sqliteD1();
    const user = db.prepare(
      'INSERT INTO users (id, github_id, github_login, avatar_url, created_at) VALUES (?, ?, ?, NULL, 0)',
    );
    // alice (gh:1) renamed away; mallory (gh:2) then registered the freed "alice".
    user.run('gh:1', 1, 'alice-new');
    user.run('gh:2', 2, 'alice');
    db.prepare(
      "INSERT INTO apps (id, owner_login, owner_id, created_at, store) VALUES ('timer', 'alice', 'gh:1', 0, 'apps')",
    ).run();
    const get = async (path: string, userId: string) =>
      app.request(
        path,
        {
          headers: {
            Authorization: `Bearer ${await signSession(userId, KEY, { aud: 'console' })}`,
          },
        },
        { DB: d1, SESSION_SIGNING_KEY: KEY },
      );
    return { db, d1, get };
  }

  it("a new holder of the old username does not own the previous holder's app", async () => {
    const { get } = setup();
    expect(await (await get('/v1/apps/timer/roles/check/owner', 'gh:2')).json()).toMatchObject({
      has: false,
    });
    expect(await (await get('/v1/apps/timer/roles/check/owner', 'gh:1')).json()).toMatchObject({
      has: true,
    });
    expect((await get('/v1/apps/timer/roles', 'gh:2')).status).toBe(403);
    expect((await get('/v1/apps/timer/roles', 'gh:1')).status).toBe(200);
  });

  it('computeRoles lists only the apps bound to the account id', async () => {
    const { d1 } = setup();
    const env = { DB: d1 } as never;
    expect((await computeRoles('gh:2', 'alice', env)).appRoles).toEqual({});
    expect((await computeRoles('gh:1', 'alice-new', env)).appRoles).toEqual({ timer: ['owner'] });
  });

  it('the first GitHub sign-in as a login binds an app attributed to it before it had an id', async () => {
    const { db, d1 } = setup();
    db.prepare(
      "INSERT INTO apps (id, owner_login, owner_id, created_at, store) VALUES ('gift', 'carol', NULL, 0, 'apps')",
    ).run();
    expect((await computeRoles('gh:2', 'alice', { DB: d1 } as never)).appRoles).toEqual({});
    db.prepare(
      "INSERT INTO users (id, github_id, github_login, created_at) VALUES ('gh:3', 3, 'carol', 0)",
    ).run();
    // The testutil trigger already bound it on insert; sign-in is the production path.
    db.prepare("UPDATE apps SET owner_id = NULL WHERE id = 'gift'").run();
    const roles = await computeRoles('gh:3', 'Carol', { DB: d1 } as never);
    expect(roles.appRoles).toEqual({ gift: ['owner'] });
    expect(
      db.prepare("SELECT owner_id FROM apps WHERE id = 'gift'").get() as { owner_id: string },
    ).toEqual({ owner_id: 'gh:3' });
  });

  it('a PAS row with the same id is not a FAS app: no owner, no role management (#571)', async () => {
    const { db, get } = setup();
    db.prepare(
      "INSERT INTO apps (id, owner_login, owner_id, created_at, store) VALUES ('pro-only', 'alice-new', 'gh:1', 0, 'apps_pro')",
    ).run();
    expect(await (await get('/v1/apps/pro-only/roles/check/owner', 'gh:1')).json()).toMatchObject({
      has: false,
    });
    expect((await get('/v1/apps/pro-only/roles', 'gh:1')).status).toBe(404);
  });
});

describe.skipIf(!hasSqlite)('migration 0048 backfill', () => {
  it('binds FAS rows to the one matching GitHub account and leaves the rest NULL', () => {
    const { db } = sqliteD1({ before: '0048' });
    const user = db.prepare(
      'INSERT INTO users (id, github_id, github_login, avatar_url, created_at) VALUES (?, ?, ?, NULL, 0)',
    );
    user.run('gh:1', 1, 'Alice');
    user.run('gh:2', 2, 'dup');
    user.run('gh:3', 3, 'DUP');
    user.run('google:x', 4, 'bob');
    const app = db.prepare(
      'INSERT INTO apps (id, owner_login, created_at, store) VALUES (?, ?, 0, ?)',
    );
    app.run('a1', 'alice', 'apps');
    app.run('a2', 'dup', 'apps'); // two accounts hold it: ambiguous
    app.run('a3', 'bob', 'apps'); // only a non-GitHub account
    app.run('a4', 'alice', 'apps_pro'); // another store's row
    app.run('a5', 'nobody', 'apps');
    db.exec(migration('0048_apps_owner_id.sql'));
    const owners = Object.fromEntries(
      (
        db.prepare("SELECT id, owner_id FROM apps WHERE id LIKE 'a_'").all() as Array<{
          id: string;
          owner_id: string | null;
        }>
      ).map((r) => [r.id, r.owner_id]),
    );
    expect(owners).toEqual({ a1: 'gh:1', a2: null, a3: null, a4: null, a5: null });
  });
});
