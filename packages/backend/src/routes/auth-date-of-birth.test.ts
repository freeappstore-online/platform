import { describe, expect, it } from 'vitest';
import { app } from '../index.js';
import { signSession } from '../lib/session.js';
import { hasSqlite, sqliteD1 } from '../lib/sqlite-d1.testutil.js';

const SIGNING_KEY = 'a'.repeat(64);

describe.skipIf(!hasSqlite)('PATCH /v1/auth/me/date-of-birth (#761)', () => {
  async function setup() {
    const { db: raw, d1: real } = sqliteD1();
    const db = { raw, onUpdate: () => {} };
    const d1 = {
      ...real,
      prepare(sql: string) {
        if (sql.startsWith('UPDATE users SET date_of_birth')) db.onUpdate();
        return real.prepare(sql);
      },
    } as D1Database;
    raw
      .prepare(
        'INSERT INTO users (id, github_id, github_login, avatar_url, created_at) VALUES (?, ?, ?, NULL, 0)',
      )
      .run('gh:1', 1, 'alice');
    const env = { DB: d1, SESSION_SIGNING_KEY: SIGNING_KEY };
    const headers = {
      Authorization: `Bearer ${await signSession('gh:1', SIGNING_KEY, { aud: 'console' })}`,
      'Content-Type': 'application/json',
    };
    const set = (dateOfBirth: string) =>
      app.request(
        '/v1/auth/me/date-of-birth',
        { method: 'PATCH', headers, body: JSON.stringify({ dateOfBirth }) },
        env,
      );
    const stored = () =>
      (raw.prepare('SELECT date_of_birth FROM users').get() as { date_of_birth: string | null })
        .date_of_birth;
    return { set, stored, db };
  }

  it.each(['2000-02-31', '2001-02-29', '2000-04-31', '2000-13-01'])(
    'refuses the impossible date %s',
    async (dob) => {
      const { set, stored } = await setup();
      expect((await set(dob)).status).toBe(400);
      expect(stored()).toBeNull();
    },
  );

  it('stores a real date', async () => {
    const { set, stored } = await setup();
    expect((await set('2000-02-29')).status).toBe(200);
    expect(stored()).toBe('2000-02-29');
  });

  it('does not overwrite a date a concurrent call set after the check', async () => {
    const { set, stored, db } = await setup();
    // The other call writes between this call's session read and its UPDATE.
    db.onUpdate = () => db.raw.prepare("UPDATE users SET date_of_birth = '1990-01-01'").run();
    const res = await set('2000-02-29');
    expect(res.status).toBe(409);
    expect(stored()).toBe('1990-01-01');
  });
});
