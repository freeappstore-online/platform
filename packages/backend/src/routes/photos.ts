import { Hono } from 'hono';
import { APP_ID_RE } from '../lib/apps.js';
import { FAS_APP_ROWS, HttpError, requireAppUser } from '../lib/auth.js';
import { PHOTO_MAX_BYTES, PHOTO_RETENTION_MS, sanitizePhoto } from '../lib/photo-image.js';
import type { Env } from '../types.js';

interface PhotoRow {
  id: string;
  app_id: string;
  owner_id: string;
  object_key: string;
  visibility: 'private' | 'public';
  state: string;
  bytes: number;
  content_type: string;
  width: number;
  height: number;
  created_at: number;
  expires_at: number;
}
export const PHOTO_QUOTAS = {
  userFiles: 100,
  userBytes: 20_000_000,
  userDaily: 20,
  appFiles: 10_000,
  appBytes: 1_000_000_000,
  appDaily: 1_000,
};
export const photoRoutes = new Hono<{ Bindings: Env }>();

photoRoutes.use('/apps/:appId/photos*', async (c, next) => {
  const id = c.req.param('appId')!;
  if (!APP_ID_RE.test(id)) return c.text('unknown app', 404);
  const exists = await c.env.DB.prepare(`SELECT 1 FROM apps WHERE id = ? AND ${FAS_APP_ROWS}`)
    .bind(id)
    .first();
  if (!exists) return c.text('unknown app', 404);
  if (!c.env.UPLOADS) return c.text('photo storage unavailable', 503);
  await next();
});

function info(row: PhotoRow) {
  return {
    id: row.id,
    url: `/v1/apps/${row.app_id}/photos/${row.id}`,
    visibility: row.visibility,
    bytes: row.bytes,
    contentType: row.content_type,
    width: row.width,
    height: row.height,
    createdAt: row.created_at,
    expiresAt: row.expires_at,
  };
}

photoRoutes.post('/apps/:appId/photos', async (c) => {
  const appId = c.req.param('appId');
  const user = await requireAppUser(c, appId);
  const visibility = c.req.query('visibility') ?? 'private';
  if (!['private', 'public'].includes(visibility)) return c.text('invalid visibility', 400);
  const type = c.req.header('Content-Type')?.split(';')[0];
  if (!['image/jpeg', 'image/webp'].includes(type ?? ''))
    return c.text('only JPEG and WebP photos are supported', 415);
  const length = Number(c.req.header('Content-Length'));
  if (length > PHOTO_MAX_BYTES) return c.text(`photo exceeds ${PHOTO_MAX_BYTES} bytes`, 413);
  // Bound actual streamed bytes too: Content-Length is not trusted.
  const reader = c.req.raw.body?.getReader();
  if (!reader) return c.text('photo required', 400);
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > PHOTO_MAX_BYTES) {
        await reader.cancel();
        return c.text(`photo exceeds ${PHOTO_MAX_BYTES} bytes`, 413);
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const input = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    input.set(chunk, offset);
    offset += chunk.length;
  }
  let image;
  try {
    image = sanitizePhoto(input);
  } catch (error) {
    return c.text((error as Error).message, 400);
  }
  if (image.type !== type) return c.text('photo format does not match Content-Type', 415);
  const now = Date.now(),
    id = crypto.randomUUID();
  const key = `${appId}/${encodeURIComponent(user.id)}/${id}`;
  const row: PhotoRow = {
    id,
    app_id: appId,
    owner_id: user.id,
    object_key: key,
    visibility: visibility as 'private' | 'public',
    state: 'pending',
    bytes: image.bytes.length,
    content_type: image.type,
    width: image.width,
    height: image.height,
    created_at: now,
    expires_at: now + PHOTO_RETENTION_MS,
  };
  const q = PHOTO_QUOTAS;
  // A single conditional INSERT serializes quota reservations in D1. Deleted
  // rows still count against the UTC-day limit, preventing upload/delete abuse.
  const reservation = await c.env.DB.prepare(`
    INSERT INTO photos (id, app_id, owner_id, object_key, visibility, state, bytes, content_type, width, height, created_at, expires_at)
    SELECT ?1, ?2, ?3, ?4, ?5, 'pending', ?6, ?7, ?8, ?9, ?10, ?11
    WHERE (SELECT COUNT(*) FROM photos WHERE app_id = ?2 AND state != 'deleted' AND expires_at > ?10) < ?12
      AND (SELECT COALESCE(SUM(bytes), 0) FROM photos WHERE app_id = ?2 AND state != 'deleted' AND expires_at > ?10) + ?6 <= ?13
      AND (SELECT COUNT(*) FROM photos WHERE app_id = ?2 AND created_at >= ?14) < ?15
      AND (SELECT COUNT(*) FROM photos WHERE app_id = ?2 AND owner_id = ?3 AND state != 'deleted' AND expires_at > ?10) < ?16
      AND (SELECT COALESCE(SUM(bytes), 0) FROM photos WHERE app_id = ?2 AND owner_id = ?3 AND state != 'deleted' AND expires_at > ?10) + ?6 <= ?17
      AND (SELECT COUNT(*) FROM photos WHERE owner_id = ?3 AND created_at >= ?14) < ?18
  `)
    .bind(
      id,
      appId,
      user.id,
      key,
      visibility,
      row.bytes,
      image.type,
      image.width,
      image.height,
      now,
      row.expires_at,
      q.appFiles,
      q.appBytes,
      Math.floor(now / 86400000) * 86400000,
      q.appDaily,
      q.userFiles,
      q.userBytes,
      q.userDaily,
    )
    .run();
  if (!reservation.meta.changes)
    return c.text('photo quota reached; delete old photos or try tomorrow', 429);
  try {
    await c.env.UPLOADS!.put(key, image.bytes, { httpMetadata: { contentType: image.type } });
    const ready = await c.env.DB.prepare(
      "UPDATE photos SET state = 'ready' WHERE id = ? AND state = 'pending'",
    )
      .bind(id)
      .run();
    if (!ready.meta.changes) throw new Error('upload reservation lost');
  } catch (error) {
    // Tombstone first: public reads stop even when the object deletion fails.
    await c.env.DB.prepare("UPDATE photos SET state = 'deleted' WHERE id = ?").bind(id).run();
    await c.env.UPLOADS!.delete(key).catch(() => {});
    throw error;
  }
  return c.json(info(row), 201);
});

photoRoutes.get('/apps/:appId/photos', async (c) => {
  const user = await requireAppUser(c, c.req.param('appId'));
  const { results } = await c.env.DB.prepare(
    "SELECT * FROM photos WHERE app_id = ? AND owner_id = ? AND state = 'ready' AND expires_at > ? ORDER BY created_at DESC LIMIT 100",
  )
    .bind(c.req.param('appId'), user.id, Date.now())
    .all<PhotoRow>();
  return c.json({ photos: results.map(info) });
});

photoRoutes.get('/apps/:appId/photos/:id', async (c) => {
  const row = await c.env.DB.prepare(`SELECT p.* FROM photos p JOIN users u ON u.id = p.owner_id
    WHERE p.id = ? AND p.app_id = ? AND p.state = 'ready' AND p.expires_at > ?`)
    .bind(c.req.param('id'), c.req.param('appId'), Date.now())
    .first<PhotoRow>();
  if (!row) return c.text('not found', 404);
  if (row.visibility !== 'public') {
    const user = await requireAppUser(c, row.app_id);
    if (user.id !== row.owner_id) throw new HttpError(404, 'not found');
  }
  const object = await c.env.UPLOADS!.get(row.object_key);
  if (!object) return c.text('not found', 404);
  return new Response(object.body, {
    headers: {
      'Content-Type': row.content_type,
      'Cache-Control': 'no-store',
      'Content-Length': String(object.size),
      'X-Content-Type-Options': 'nosniff',
      'Content-Disposition': 'inline',
    },
  });
});

photoRoutes.delete('/apps/:appId/photos/:id', async (c) => {
  const user = await requireAppUser(c, c.req.param('appId'));
  const row = await c.env.DB.prepare(
    'SELECT * FROM photos WHERE id = ? AND app_id = ? AND owner_id = ?',
  )
    .bind(c.req.param('id'), c.req.param('appId'), user.id)
    .first<PhotoRow>();
  if (!row) return c.text('not found', 404);
  await c.env.DB.prepare("UPDATE photos SET state = 'deleted' WHERE id = ?").bind(row.id).run();
  await c.env.UPLOADS!.delete(row.object_key);
  return c.body(null, 204);
});

/** Bounded, retryable cleanup; R2 lifecycle is the independent 90-day backstop. */
export async function prunePhotos(env: Env, now = Date.now(), limit = 100): Promise<number> {
  if (!env.UPLOADS) return 0;
  const { results } = await env.DB.prepare(`SELECT p.* FROM photos p
    WHERE p.expires_at <= ?1 OR (p.state = 'deleted' AND p.created_at < ?2)
      OR (p.state = 'pending' AND p.created_at < ?3)
      OR NOT EXISTS (SELECT 1 FROM users u WHERE u.id = p.owner_id)
      OR NOT EXISTS (SELECT 1 FROM apps a WHERE a.id = p.app_id AND (a.store IS NULL OR a.store = 'apps'))
    ORDER BY p.created_at LIMIT ?4`)
    .bind(now, Math.floor(now / 86400000) * 86400000, now - 3600000, limit)
    .all<PhotoRow>();
  for (const row of results) {
    await env.UPLOADS.delete(row.object_key);
    // Preserve today's reservation even after an abandoned upload.
    if (row.created_at >= Math.floor(now / 86400000) * 86400000) {
      await env.DB.prepare("UPDATE photos SET state = 'deleted' WHERE id = ?").bind(row.id).run();
    } else {
      await env.DB.prepare('DELETE FROM photos WHERE id = ?').bind(row.id).run();
    }
  }
  return results.length;
}
