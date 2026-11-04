import { describe, expect, it } from 'vitest';
import { app } from '../index.js';
import { signSession } from '../lib/session.js';
import { hasSqlite, sqliteD1 } from '../lib/sqlite-d1.testutil.js';

const key = 'a'.repeat(64);
async function setup() {
  const { db, d1 } = sqliteD1();
  db.exec(
    "INSERT INTO apps (id, owner_login, created_at) VALUES ('demo', 'alice', 0), ('other', 'alice', 0)",
  );
  const request = async (
    user: string | null,
    path: string,
    method = 'GET',
    body?: string,
    database = d1,
  ) =>
    app.request(
      `/v1/apps/${path}`,
      {
        method,
        headers: user ? { Authorization: `Bearer ${await signSession(user, key)}` } : {},
        ...(body === undefined ? {} : { body }),
      },
      { DB: database, SESSION_SIGNING_KEY: key },
    );
  const created = await request('alice', 'demo/data-rooms', 'POST');
  expect(created.status).toBe(201);
  const { id } = (await created.json()) as { id: string };
  const room = `demo/data-rooms/${id}`;
  return { db, d1, request, room, id };
}

describe.skipIf(!hasSqlite)('durable data room permissions (synthetic identities only)', () => {
  it('keeps private records unreachable through public collections', async () => {
    const { request, room } = await setup();
    const created = await request('alice', `${room}/db/votes`, 'POST', '{"secret":42}');
    const { id } = (await created.json()) as { id: string };
    expect((await request(null, `demo/db/votes/${id}`)).status).toBe(404);
    const publicList = await request(null, 'demo/db/votes?owner=alice');
    expect(publicList.status).toBe(200);
    expect(await publicList.json()).toEqual({ documents: [], total: 0 });
    const privateList = await request('alice', `${room}/db/votes`);
    expect(privateList.headers.get('Cache-Control')).toBe('no-store');
    expect(await privateList.json()).toEqual({ documents: [{ id, data: { secret: 42 } }] });
    expect((await request('alice', `${room}/db/votes`, 'POST', '[]')).status).toBe(400);
    expect((await request('alice', `${room}/db/votes`, 'POST', '{')).status).toBe(400);
    expect(
      (
        await request(
          'alice',
          `${room}/db/votes`,
          'POST',
          JSON.stringify({ text: 'x'.repeat(65536) }),
        )
      ).status,
    ).toBe(413);
  });

  it('purges app and local owner account data and removes deleted user memberships', async () => {
    for (const deletion of ['app', 'owner', 'member']) {
      const { db, request, room } = await setup();
      db.exec(
        "INSERT INTO users (id, github_id, github_login, created_at) VALUES ('alice', 1, 'alice', 0), ('bob', 2, 'bob', 0)",
      );
      await request('alice', `${room}/members/bob`, 'PUT');
      await request('alice', `${room}/db/votes`, 'POST', '{}');
      if (deletion === 'app') db.exec("DELETE FROM apps WHERE id = 'demo'");
      else db.prepare('DELETE FROM users WHERE id = ?').run(deletion === 'owner' ? 'alice' : 'bob');
      expect(db.prepare('SELECT COUNT(*) AS n FROM data_room_members').get()).toEqual({ n: 0 });
      if (deletion !== 'member') {
        expect(db.prepare('SELECT COUNT(*) AS n FROM data_room_documents').get()).toEqual({ n: 0 });
        expect((await request('alice', `${room}/db/votes`)).status).toBe(404);
      }
    }
  });

  it('denies anonymous and outside users every data operation and membership escalation', async () => {
    const { request, room } = await setup();
    const created = await request('alice', `${room}/db/votes`, 'POST', '{"secret":42}');
    const { id } = (await created.json()) as { id: string };
    for (const user of [null, 'mallory']) {
      for (const [path, method, body] of [
        [`${room}/db/votes?owner=alice&roomId=other`, 'GET'],
        [`${room}/db/votes/${id}`, 'GET'],
        [`${room}/db/votes`, 'POST', '{}'],
        [`${room}/db/votes/${id}`, 'PUT', '{}'],
        [`${room}/db/votes/${id}`, 'DELETE'],
        [`${room}/members/mallory`, 'PUT'],
        [room, 'DELETE'],
      ]) {
        const response = await request(user, path!, method!, body);
        expect(response.status).toBe(user ? 404 : 401);
        expect(await response.text()).not.toContain('secret');
      }
    }
  });

  it('allows member CRUD, isolates app/room/collection, revokes access and allows leaving', async () => {
    const { request, room, id } = await setup();
    expect((await request('alice', `${room}/members/bob`, 'PUT')).status).toBe(204);
    const created = await request('bob', `${room}/db/votes`, 'POST', '{"vote":5}');
    expect(created.status).toBe(201);
    const doc = (await created.json()) as { id: string };
    expect((await request('alice', `${room}/db/votes/${doc.id}`)).status).toBe(200);
    expect((await request('bob', `${room}/db/votes`)).status).toBe(200);
    expect((await request('bob', `${room}/db/votes/${doc.id}`, 'PUT', '{"vote":8}')).status).toBe(
      200,
    );
    for (const path of [`other/data-rooms/${id}`, 'demo/data-rooms/guessed']) {
      expect((await request('bob', `${path}/db/votes/${doc.id}`)).status).toBe(404);
    }
    expect((await request('bob', `${room}/db/other/${doc.id}`)).status).toBe(404);
    expect((await request('bob', `${room}/members/eve`, 'PUT')).status).toBe(404);
    expect((await request('bob', room, 'DELETE')).status).toBe(404);
    expect((await request('bob', `${room}/db/votes/${doc.id}`, 'DELETE')).status).toBe(204);
    expect((await request('alice', `${room}/members/bob`, 'DELETE')).status).toBe(204);
    expect((await request('bob', `${room}/db/votes`)).status).toBe(404);
    await request('alice', `${room}/members/bob`, 'PUT');
    expect((await request('bob', `${room}/members/bob`, 'DELETE')).status).toBe(204);
    expect((await request('bob', `${room}/db/votes`, 'POST', '{}')).status).toBe(404);
  });

  it('owner deletion purges records and memberships and prevents access', async () => {
    const { db, request, room } = await setup();
    await request('alice', `${room}/members/bob`, 'PUT');
    await request('bob', `${room}/db/votes`, 'POST', '{}');
    expect((await request('alice', room, 'DELETE')).status).toBe(204);
    for (const table of ['data_rooms', 'data_room_members', 'data_room_documents']) {
      expect(db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get()).toEqual({ n: 0 });
    }
    expect((await request('alice', `${room}/db/votes`)).status).toBe(404);
  });

  it('rechecks permission at the statement after membership changes during a request', async () => {
    const { db, d1, request, room, id } = await setup();
    await request('alice', `${room}/members/bob`, 'PUT');
    const created = await request('bob', `${room}/db/votes`, 'POST', '{}');
    const doc = (await created.json()) as { id: string };
    for (const [method, suffix, body] of [
      ['GET', '', undefined],
      ['GET', `/${doc.id}`, undefined],
      ['POST', '', '{}'],
      ['PUT', `/${doc.id}`, '{}'],
      ['DELETE', `/${doc.id}`, undefined],
    ]) {
      await request('alice', `${room}/members/bob`, 'PUT');
      const wrapped = {
        prepare(sql: string) {
          // Simulate revocation after authentication but before the record statement executes.
          if (sql.includes('data_room_documents')) {
            db.prepare('DELETE FROM data_room_members WHERE room_id = ? AND user_id = ?').run(
              id,
              'bob',
            );
          }
          return d1.prepare(sql);
        },
      } as D1Database;
      expect(
        (await request('bob', `${room}/db/votes${suffix}`, method, body, wrapped)).status,
      ).toBe(404);
    }
  });
});
