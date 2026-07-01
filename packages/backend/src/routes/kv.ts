import { Hono } from 'hono';
import { appExists } from '../lib/apps.js';
import { HttpError, requireUser } from '../lib/auth.js';
import { checkKvWrite, KV_LIMITS } from '../lib/quota.js';
import type { Env } from '../types.js';

export const kvRoutes = new Hono<{ Bindings: Env }>();

/** List all keys for the current user in this app. Optional ?prefix= filter. */
kvRoutes.get('/apps/:appId/kv', async (c) => {
  try {
    const user = await requireUser(c);
    const { appId } = c.req.param();
    const prefix = c.req.query('prefix');

    let query: string;
    let bindings: unknown[];
    if (prefix) {
      query = 'SELECT key FROM kv WHERE app_id = ? AND user_id = ? AND key LIKE ? ORDER BY key';
      bindings = [appId, user.id, `${prefix}%`];
    } else {
      query = 'SELECT key FROM kv WHERE app_id = ? AND user_id = ? ORDER BY key';
      bindings = [appId, user.id];
    }

    const { results } = await c.env.DB.prepare(query)
      .bind(...bindings)
      .all<{ key: string }>();
    return c.json(results.map((r) => r.key));
  } catch (err) {
    if (err instanceof HttpError) return c.json({ error: err.message }, err.status as 401);
    throw err;
  }
});

kvRoutes.get('/apps/:appId/kv/:key', async (c) => {
  try {
    const user = await requireUser(c);
    const { appId, key } = c.req.param();
    const row = await c.env.DB.prepare(
      'SELECT value FROM kv WHERE app_id = ? AND user_id = ? AND key = ?',
    )
      .bind(appId, user.id, key)
      .first<{ value: unknown }>();
    if (!row) return c.text('not found', 404);
    return new Response(toBytes(row.value), {
      headers: { 'content-type': 'application/json' },
    });
  } catch (err) {
    if (err instanceof HttpError) return c.json({ error: err.message }, err.status as 401);
    throw err;
  }
});

/**
 * D1 BLOB columns come back differently across runtimes: production returns
 * ArrayBuffer, miniflare (wrangler dev) returns plain `number[]`. Coerce to
 * Uint8Array so `new Response(...)` sends raw bytes either way. Without this,
 * an Array<number> ends up stringified ("123,34,104,...") in the response.
 */
export function toBytes(value: unknown): Uint8Array {
  if (value instanceof Uint8Array) return value;
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  if (Array.isArray(value)) return Uint8Array.from(value as number[]);
  return new Uint8Array(0);
}

kvRoutes.put('/apps/:appId/kv/:key', async (c) => {
  try {
    const user = await requireUser(c);
    const { appId, key } = c.req.param();
    if (!(await appExists(c.env, appId))) return c.text('unknown app', 404);
    // Cap key length: keys are stored but not metered against the value quota,
    // so an unbounded key would bypass the per-user byte cap.
    if (key.length > 512) return c.text('key too long (max 512 chars)', 400);
    const body = await c.req.arrayBuffer();
    if (body.byteLength === 0) {
      // An empty body would store 0 bytes; subsequent kv.get() on the SDK
      // side calls res.json() which throws on an empty response. Reject
      // here so we never end up in that state.
      return c.text('empty values are not allowed; use DELETE to remove a key', 400);
    }

    const row = await c.env.DB.prepare(
      `SELECT
         COALESCE(SUM(value_size_bytes), 0) AS total,
         COUNT(*) AS keys,
         COALESCE(SUM(CASE WHEN key = ? THEN 1 ELSE 0 END), 0) AS key_exists,
         COALESCE(SUM(CASE WHEN key = ? THEN value_size_bytes ELSE 0 END), 0) AS existing
       FROM kv WHERE app_id = ? AND user_id = ?`,
    )
      .bind(key, key, appId, user.id)
      .first<{ total: number; keys: number; key_exists: number; existing: number }>();

    const check = checkKvWrite(
      {
        totalBytes: row?.total ?? 0,
        keyCount: row?.keys ?? 0,
        existingKeyBytes: row?.existing ?? 0,
        keyExists: (row?.key_exists ?? 0) > 0,
      },
      body.byteLength,
      KV_LIMITS,
    );
    if (!check.ok) return c.text(check.reason, 413);

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
    if (err instanceof HttpError) return c.json({ error: err.message }, err.status as 401);
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
    if (err instanceof HttpError) return c.json({ error: err.message }, err.status as 401);
    throw err;
  }
});
