import { Hono } from 'hono';
import type { Env } from '../types.js';
import { requireUser, HttpError } from '../lib/auth.js';

const MAX_VALUE_BYTES = 64 * 1024;
const MAX_TOTAL_BYTES_PER_USER = 1024 * 1024;
const MAX_KEYS_PER_USER = 100;

export const kvRoutes = new Hono<{ Bindings: Env }>();

kvRoutes.get('/apps/:appId/kv/:key', async (c) => {
  try {
    const user = await requireUser(c);
    const { appId, key } = c.req.param();
    const row = await c.env.DB.prepare(
      'SELECT value FROM kv WHERE app_id = ? AND user_id = ? AND key = ?',
    )
      .bind(appId, user.id, key)
      .first<{ value: ArrayBuffer }>();
    if (!row) return c.text('not found', 404);
    return new Response(row.value as ArrayBuffer, {
      headers: { 'content-type': 'application/json' },
    });
  } catch (err) {
    if (err instanceof HttpError) return c.text(err.message, err.status as 401);
    throw err;
  }
});

kvRoutes.put('/apps/:appId/kv/:key', async (c) => {
  try {
    const user = await requireUser(c);
    const { appId, key } = c.req.param();
    const body = await c.req.arrayBuffer();
    if (body.byteLength > MAX_VALUE_BYTES) {
      return c.text(`value exceeds ${MAX_VALUE_BYTES} bytes`, 413);
    }

    const usage = await c.env.DB.prepare(
      `SELECT
         COALESCE(SUM(value_size_bytes), 0) AS total,
         COUNT(*) AS keys,
         COALESCE(SUM(CASE WHEN key = ? THEN value_size_bytes ELSE 0 END), 0) AS existing
       FROM kv WHERE app_id = ? AND user_id = ?`,
    )
      .bind(key, appId, user.id)
      .first<{ total: number; keys: number; existing: number }>();

    const projectedTotal = (usage?.total ?? 0) - (usage?.existing ?? 0) + body.byteLength;
    if (projectedTotal > MAX_TOTAL_BYTES_PER_USER) {
      return c.text(`per-user kv quota exceeded`, 413);
    }
    const isNewKey = (usage?.existing ?? 0) === 0;
    if (isNewKey && (usage?.keys ?? 0) >= MAX_KEYS_PER_USER) {
      return c.text(`per-user key count limit (${MAX_KEYS_PER_USER}) exceeded`, 413);
    }

    await c.env.DB.prepare(
      `INSERT INTO kv (app_id, user_id, key, value, value_size_bytes, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(app_id, user_id, key) DO UPDATE SET
         value = excluded.value,
         value_size_bytes = excluded.value_size_bytes,
         updated_at = excluded.updated_at`,
    )
      .bind(appId, user.id, key, body, body.byteLength, Date.now())
      .run();

    return c.body(null, 204);
  } catch (err) {
    if (err instanceof HttpError) return c.text(err.message, err.status as 401);
    throw err;
  }
});

kvRoutes.delete('/apps/:appId/kv/:key', async (c) => {
  try {
    const user = await requireUser(c);
    const { appId, key } = c.req.param();
    const result = await c.env.DB.prepare(
      'DELETE FROM kv WHERE app_id = ? AND user_id = ? AND key = ?',
    )
      .bind(appId, user.id, key)
      .run();
    if (result.meta.changes === 0) return c.text('not found', 404);
    return c.body(null, 204);
  } catch (err) {
    if (err instanceof HttpError) return c.text(err.message, err.status as 401);
    throw err;
  }
});
