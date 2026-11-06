import { Hono } from 'hono';
import { requireAppUser } from '../lib/auth.js';
import { queryLimit, queryOffset } from '../lib/paging.js';
import type { Env } from '../types.js';

export const dataRoomRoutes = new Hono<{ Bindings: Env; Variables: { uid: string } }>();
const base = '/apps/:appId/data-rooms';
const room = `${base}/:roomId`;
const docs = `${room}/db/:collection`;

dataRoomRoutes.use(`${base}/*`, async (c, next) => {
  c.set('uid', (await requireAppUser(c, c.req.param('appId'))).id);
  c.header('Cache-Control', 'no-store');
  for (const value of Object.values(c.req.param())) {
    if (!/^[a-zA-Z0-9:_-]{1,128}$/.test(value)) return c.text('invalid identifier', 400);
  }
  await next();
});

// Every statement authorizes against current membership, including writes after body reads.
const access = `EXISTS (SELECT 1 FROM data_rooms r WHERE r.app_id = ? AND r.id = ?
  AND (r.owner_id = ? OR EXISTS (SELECT 1 FROM data_room_members m
    WHERE m.app_id = r.app_id AND m.room_id = r.id AND m.user_id = ?)))`;
const owner =
  'EXISTS (SELECT 1 FROM data_rooms r WHERE r.app_id = ? AND r.id = ? AND r.owner_id = ?)';

dataRoomRoutes.post(base, async (c) => {
  const user = await requireAppUser(c, c.req.param('appId'));
  const id = crypto.randomUUID();
  const result = await c.env.DB.prepare(`INSERT INTO data_rooms (app_id, id, owner_id)
    SELECT ?, ?, ? WHERE EXISTS (SELECT 1 FROM apps WHERE id = ?)`)
    .bind(c.req.param('appId'), id, user.id, c.req.param('appId'))
    .run();
  return result.meta.changes ? c.json({ id }, 201) : c.text('unknown app', 404);
});

dataRoomRoutes.put(`${room}/members/:userId`, async (c) => {
  const { appId, roomId, userId } = c.req.param();
  const result = await c.env.DB.prepare(`INSERT INTO data_room_members (app_id, room_id, user_id)
    SELECT ?, ?, ? WHERE ${owner} ON CONFLICT DO NOTHING`)
    .bind(appId, roomId, userId, appId, roomId, c.get('uid'))
    .run();
  return result.meta.changes ? c.body(null, 204) : c.text('not found or already a member', 404);
});

dataRoomRoutes.delete(`${room}/members/:userId`, async (c) => {
  const { appId, roomId, userId } = c.req.param();
  const uid = c.get('uid');
  const result = await c.env.DB.prepare(`DELETE FROM data_room_members
    WHERE app_id = ? AND room_id = ? AND user_id = ? AND (${owner} OR user_id = ?)`)
    .bind(appId, roomId, userId, appId, roomId, uid, uid)
    .run();
  return result.meta.changes ? c.body(null, 204) : c.text('not found', 404);
});

dataRoomRoutes.delete(room, async (c) => {
  const result = await c.env.DB.prepare(
    'DELETE FROM data_rooms WHERE app_id = ? AND id = ? AND owner_id = ?',
  )
    .bind(c.req.param('appId'), c.req.param('roomId'), c.get('uid'))
    .run();
  return result.meta.changes ? c.body(null, 204) : c.text('not found', 404);
});

dataRoomRoutes.get(docs, async (c) => {
  const { appId, roomId, collection } = c.req.param();
  const uid = c.get('uid');
  // One statement gives a consistent authorized snapshot, even for empty collections.
  const row = await c.env.DB.prepare(`SELECT
    (SELECT json_group_array(json_object('id', d.id, 'data', json(d.data))) FROM
      (SELECT id, data FROM data_room_documents WHERE app_id = ? AND room_id = ? AND collection = ?
       ORDER BY id LIMIT ? OFFSET ?) d) AS documents
    WHERE ${access}`)
    .bind(
      appId,
      roomId,
      collection,
      queryLimit(c.req.query('limit'), 20, 100),
      queryOffset(c.req.query('offset')),
      appId,
      roomId,
      uid,
      uid,
    )
    .first<{ documents: string }>();
  return row ? c.json({ documents: JSON.parse(row.documents) }) : c.text('not found', 404);
});

dataRoomRoutes.get(`${docs}/:id`, async (c) => {
  const { appId, roomId, collection, id } = c.req.param();
  const uid = c.get('uid');
  const row = await c.env.DB.prepare(`SELECT id, data FROM data_room_documents
    WHERE app_id = ? AND room_id = ? AND collection = ? AND id = ? AND ${access}`)
    .bind(appId, roomId, collection, id, appId, roomId, uid, uid)
    .first<{ id: string; data: string }>();
  return row ? c.json({ id: row.id, data: JSON.parse(row.data) }) : c.text('not found', 404);
});

for (const method of ['post', 'put'] as const) {
  dataRoomRoutes[method](method === 'post' ? docs : `${docs}/:id`, async (c) => {
    const { appId, roomId, collection } = c.req.param();
    const uid = c.get('uid');
    const body = await c.req.text();
    if (new TextEncoder().encode(body).length > 65536) return c.text('document too large', 413);
    let data: unknown;
    try {
      data = JSON.parse(body);
    } catch {
      return c.text('invalid JSON', 400);
    }
    if (!data || typeof data !== 'object' || Array.isArray(data))
      return c.text('expected object', 400);
    const id = method === 'post' ? crypto.randomUUID() : c.req.param('id');
    const result =
      method === 'post'
        ? await c.env.DB.prepare(`INSERT INTO data_room_documents (app_id, room_id, collection, id, data)
          SELECT ?, ?, ?, ?, ? WHERE ${access}
          AND (SELECT COUNT(*) FROM data_room_documents WHERE app_id = ? AND room_id = ? AND collection = ?) < 10000`)
            .bind(
              appId,
              roomId,
              collection,
              id,
              body,
              appId,
              roomId,
              uid,
              uid,
              appId,
              roomId,
              collection,
            )
            .run()
        : await c.env.DB.prepare(`UPDATE data_room_documents SET data = ?
          WHERE app_id = ? AND room_id = ? AND collection = ? AND id = ? AND ${access}`)
            .bind(body, appId, roomId, collection, id, appId, roomId, uid, uid)
            .run();
    return result.meta.changes
      ? c.json({ id, data }, method === 'post' ? 201 : 200)
      : c.text('not found or capacity reached', 404);
  });
}

dataRoomRoutes.delete(`${docs}/:id`, async (c) => {
  const { appId, roomId, collection, id } = c.req.param();
  const uid = c.get('uid');
  const result = await c.env.DB.prepare(`DELETE FROM data_room_documents
    WHERE app_id = ? AND room_id = ? AND collection = ? AND id = ? AND ${access}`)
    .bind(appId, roomId, collection, id, appId, roomId, uid, uid)
    .run();
  return result.meta.changes ? c.body(null, 204) : c.text('not found', 404);
});
