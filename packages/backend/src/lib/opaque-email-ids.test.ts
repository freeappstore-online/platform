/**
 * #434: migration 0032 replaces every `email:<address>` user id with an opaque
 * `em:` id, consistently across tables, and scripts/verify-434-no-email-ids.sql
 * finds what it could not rewrite. Phase 1 code reads both id formats.
 */
import { describe, expect, it } from 'vitest';
import { app } from '../index.js';
import { signSession } from './session.js';
import { hasSqlite, migration, type SqliteDb, sqliteD1 } from './sqlite-d1.testutil.js';

const MIGRATION = '0032_opaque_email_user_ids.sql';
const SIGNING_KEY = 'a'.repeat(64);
const ALICE = 'email:alice@example.com';
// A longer address that has ALICE as a prefix: free-text rewrites must not
// turn it into `<alice's new id>unity`.
const ALICE2 = 'email:alice@example.community';
const BOB = 'email:bob@example.org';
const GONE = 'email:gone@example.org'; // deleted account; orphaned vote only

function seed(db: SqliteDb) {
  const user = db.prepare(
    `INSERT INTO users (id, github_id, github_login, created_at, provider, provider_id, email, display_name)
     VALUES (?, 0, ?, 1, ?, ?, ?, ?)`,
  );
  for (const id of [ALICE, ALICE2, BOB]) {
    const email = id.slice('email:'.length);
    const local = email.split('@')[0];
    user.run(id, local, 'email', email, email, local);
  }
  user.run('gh:1', 'octocat', 'github', '1', null, 'octocat');
  // Google: login defaulted to the local part, the display name came from the profile.
  user.run('google:7', 'jane', 'google', '7', 'jane@example.com', 'Jane Doe');

  const json = (v: unknown) => new TextEncoder().encode(JSON.stringify(v));
  const kv = db.prepare(
    'INSERT INTO kv (app_id, user_id, key, value, value_size_bytes, updated_at) VALUES (?, ?, ?, ?, ?, 1)',
  );
  const friends = json({ friends: [BOB, ALICE2] });
  kv.run('demo', ALICE, 'friends', friends, friends.byteLength);
  const binary = new Uint8Array([0, ...new TextEncoder().encode(BOB)]);
  kv.run('demo', ALICE, 'bin', binary, binary.byteLength);

  db.prepare(
    `INSERT INTO documents (app_id, collection, id, data, owner_id, created_at, updated_at)
     VALUES ('demo', 'posts', 'p1', ?, ?, 1, 1)`,
  ).run(JSON.stringify({ author: ALICE, mentions: [ALICE2] }), ALICE);
  db.prepare(
    "INSERT INTO app_roles (app_id, user_id, role_name, granted_by) VALUES ('demo', ?, 'moderator', ?)",
  ).run(BOB, ALICE);
  const friendship = db.prepare(
    `INSERT INTO friendships (user_a, user_b, status, initiator, blocker, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, 1, 1)`,
  );
  friendship.run(ALICE, BOB, 'blocked', ALICE, BOB);
  friendship.run(ALICE, 'gh:1', 'accepted', 'gh:1', null);
  db.prepare("INSERT INTO app_votes (app_id, user_id) VALUES ('demo', ?)").run(GONE);
  db.prepare("INSERT INTO counters (app_id, key, value, updated_at) VALUES ('demo', ?, 3, 1)").run(
    `score:${BOB}`,
  );
  const usage = db.prepare(
    "INSERT INTO app_proxy_usage (app_id, day, count) VALUES (?, '2026-11-05', 1)",
  );
  usage.run(`email-user:${ALICE}`);
  usage.run('email:demo'); // the per-app email quota key, not a user id
  db.prepare("INSERT INTO data_rooms (app_id, id, owner_id) VALUES ('demo', 'r1', ?)").run(ALICE);
  db.prepare(
    "INSERT INTO data_room_members (app_id, room_id, user_id) VALUES ('demo', 'r1', ?)",
  ).run(BOB);
  db.prepare(
    "INSERT INTO auth_codes (code_hash, session, app_id, code_challenge, expires_at) VALUES ('h', 's', 'demo', 'c', 1)",
  ).run();
}

/** Runs every statement of the verify script and flattens the rows. */
function verify(db: SqliteDb): { tbl: string; col: string; n: number }[] {
  const sql = migration('../scripts/verify-434-no-email-ids.sql');
  return sql
    .split(';\n')
    .map((s) => s.trim())
    .filter((s) => s.startsWith('SELECT'))
    .flatMap((s) => db.prepare(s).all() as { tbl: string; col: string; n: number }[]);
}

function newId(db: SqliteDb, email: string): string {
  const row = db
    .prepare("SELECT id FROM users WHERE provider = 'email' AND provider_id = ?")
    .get(email) as { id: string };
  return row.id;
}

describe.skipIf(!hasSqlite)('migration 0032: opaque email user ids (#434)', () => {
  function migrated() {
    const { db } = sqliteD1({ before: MIGRATION });
    seed(db);
    db.exec(migration(MIGRATION));
    const alice = newId(db, 'alice@example.com');
    const alice2 = newId(db, 'alice@example.community');
    const bob = newId(db, 'bob@example.org');
    return { db, alice, alice2, bob };
  }

  it('gives each email account a distinct opaque id and leaves other ids alone', () => {
    const { db, alice, alice2, bob } = migrated();
    for (const id of [alice, alice2, bob]) expect(id).toMatch(/^em:[0-9a-f]{32}$/);
    expect(new Set([alice, alice2, bob]).size).toBe(3);
    expect(db.prepare("SELECT id FROM users WHERE id = 'gh:1'").get()).toEqual({ id: 'gh:1' });
  });

  it('rewrites id columns with the same mapping everywhere', () => {
    const { db, alice, bob } = migrated();
    expect(db.prepare('SELECT DISTINCT user_id FROM kv').all()).toEqual([{ user_id: alice }]);
    expect(db.prepare('SELECT owner_id FROM documents').get()).toEqual({ owner_id: alice });
    expect(db.prepare('SELECT user_id, granted_by FROM app_roles').get()).toEqual({
      user_id: bob,
      granted_by: alice,
    });
    expect(db.prepare('SELECT owner_id FROM data_rooms').get()).toEqual({ owner_id: alice });
    expect(db.prepare('SELECT user_id FROM data_room_members').get()).toEqual({ user_id: bob });
    const vote = db.prepare('SELECT user_id FROM app_votes').get() as { user_id: string };
    expect(vote.user_id).toMatch(/^em:[0-9a-f]{32}$/);
  });

  it('keeps friendship pairs ordered and their initiator/blocker mapped', () => {
    const { db, alice, bob } = migrated();
    const rows = db
      .prepare('SELECT user_a, user_b, initiator, blocker FROM friendships ORDER BY status')
      .all();
    expect(rows).toEqual([
      { user_a: alice, user_b: 'gh:1', initiator: 'gh:1', blocker: null },
      {
        user_a: alice < bob ? alice : bob,
        user_b: alice < bob ? bob : alice,
        initiator: alice,
        blocker: bob,
      },
    ]);
  });

  it('rewrites ids embedded in app data, counter keys and quota keys', () => {
    const { db, alice, alice2, bob } = migrated();
    const doc = db.prepare('SELECT data FROM documents').get() as { data: string };
    expect(JSON.parse(doc.data)).toEqual({ author: alice, mentions: [alice2] });
    const kv = db
      .prepare(
        "SELECT CAST(value AS TEXT) AS v, value_size_bytes AS n FROM kv WHERE key = 'friends'",
      )
      .get() as { v: string; n: number };
    expect(JSON.parse(kv.v)).toEqual({ friends: [bob, alice2] });
    expect(kv.n).toBe(new TextEncoder().encode(kv.v).byteLength);
    expect(db.prepare('SELECT key FROM counters').get()).toEqual({ key: `score:${bob}` });
    expect(db.prepare('SELECT app_id FROM app_proxy_usage ORDER BY app_id').all()).toEqual([
      { app_id: `email-user:${alice}` },
      { app_id: 'email:demo' },
    ]);
  });

  it('drops the mapping and pending auth codes, and enforces one account per address', () => {
    const { db } = migrated();
    expect(
      db
        .prepare("SELECT name FROM sqlite_master WHERE name LIKE '\\_uid\\_%\\_434' ESCAPE '\\'")
        .get(),
    ).toBeUndefined();
    expect(db.prepare('SELECT count(*) AS n FROM auth_codes').get()).toEqual({ n: 0 });
    expect(() =>
      db
        .prepare(
          `INSERT INTO users (id, github_id, github_login, created_at, provider, provider_id)
           VALUES ('em:dup', 0, 'alice', 1, 'email', 'alice@example.com')`,
        )
        .run(),
    ).toThrow(/UNIQUE/);
  });

  it('replaces names that were the email local part; keeps provider-supplied names', () => {
    const { db, alice } = migrated();
    const a = db
      .prepare('SELECT github_login, display_name FROM users WHERE id = ?')
      .get(alice) as { github_login: string; display_name: string };
    expect(a.github_login).toMatch(/^user-[0-9a-f]{4}$/);
    expect(a.display_name).toBe(a.github_login);
    const jane = db
      .prepare("SELECT github_login, display_name FROM users WHERE id = 'google:7'")
      .get() as { github_login: string; display_name: string };
    expect(jane.github_login).toMatch(/^user-[0-9a-f]{4}$/);
    expect(jane.display_name).toBe('Jane Doe');
    expect(
      db.prepare("SELECT github_login, display_name FROM users WHERE id = 'gh:1'").get(),
    ).toEqual({ github_login: 'octocat', display_name: 'octocat' });
    expect(
      db
        .prepare(
          "SELECT count(*) AS n FROM users WHERE github_login LIKE '%alice%' OR display_name LIKE '%alice%' OR github_login = 'bob' OR github_login = 'jane'",
        )
        .get(),
    ).toEqual({ n: 0 });
  });

  it('verification finds only what was deliberately left: a binary kv value', () => {
    const { db } = migrated();
    expect(verify(db)).toEqual([{ tbl: 'kv', col: 'value', n: 1 }]);
  });

  it('verification reports every legacy id before the migration', () => {
    const { db } = sqliteD1({ before: MIGRATION });
    seed(db);
    expect(verify(db).map((r) => `${r.tbl}.${r.col}`)).toEqual(
      expect.arrayContaining([
        'users.id',
        'kv.user_id',
        'kv.value',
        'documents.data',
        'documents.owner_id',
        'friendships.user_a',
        'app_votes.user_id',
        'counters.key',
        'app_proxy_usage.app_id',
      ]),
    );
  });
});

describe.skipIf(!hasSqlite)('retired email: uids are refused (#434)', () => {
  async function me(d1: D1Database, uid: string) {
    const token = await signSession(uid, SIGNING_KEY, { aud: 'console' });
    const res = await app.request(
      '/v1/auth/me',
      { headers: { Authorization: `Bearer ${token}` } },
      { DB: d1, SESSION_SIGNING_KEY: SIGNING_KEY } as unknown as Record<string, unknown>,
    );
    return { status: res.status, body: (await res.json()) as Record<string, unknown> };
  }

  it('a session minted with the retired email: uid is 401 even though the account exists', async () => {
    const { db, d1 } = sqliteD1({ before: MIGRATION });
    seed(db);
    db.exec(migration(MIGRATION));
    // requireUser reads the #495 revocation column; the fixture stops at 0032.
    db.exec(migration('0033_sessions_valid_after.sql'));
    const r = await me(d1, ALICE);
    expect(r.status).toBe(401);
    expect(JSON.stringify(r.body)).not.toContain('alice');
  });

  it('the migrated account signs in with its em: id and the JSON carries no address', async () => {
    const { db, d1 } = sqliteD1({ before: MIGRATION });
    seed(db);
    db.exec(migration(MIGRATION));
    // requireUser reads the #495 revocation column; the fixture stops at 0032.
    db.exec(migration('0033_sessions_valid_after.sql'));
    const r = await me(d1, newId(db, 'alice@example.com'));
    expect(r.status).toBe(200);
    expect(JSON.stringify(r.body)).not.toContain('alice');
    expect(r.body).not.toHaveProperty('legacyAdmin');
  });
});
