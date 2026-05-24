/**
 * Content admin — platform-level read + delete across all apps.
 * Admin-only (ADMIN_GITHUB_LOGINS). Used by the console for moderation.
 *
 * GET  /v1/admin/kv?app=&user=&prefix=&limit=        — browse KV entries
 * DELETE /v1/admin/kv?app=&user=&key=                  — delete a KV entry
 * GET  /v1/admin/collections?app=&collection=&limit=  — browse collection docs
 * DELETE /v1/admin/collections?app=&collection=&id=    — delete a collection doc
 * GET  /v1/admin/counters?app=&prefix=                — browse counters
 * DELETE /v1/admin/counters?app=&name=                 — reset a counter
 * GET  /v1/admin/users?limit=&offset=                 — browse platform users
 * GET  /v1/admin/apps                                  — list all apps with stats
 */

import { Hono } from 'hono';
import { requireAdmin } from '../lib/auth.js';
import type { Env } from '../types.js';

export const contentAdminRoutes = new Hono<{ Bindings: Env }>();

// ── KV ──────────────────────────────────────────────────────────

contentAdminRoutes.get('/admin/kv', async (c) => {
  await requireAdmin(c);
  const appId = c.req.query('app') ?? '';
  const userId = c.req.query('user') ?? '';
  const prefix = c.req.query('prefix') ?? '';
  const limit = Math.min(Number(c.req.query('limit') || 50), 200);

  let sql = 'SELECT app_id, user_id, key, value_size_bytes as size, updated_at FROM kv WHERE 1=1';
  const params: unknown[] = [];

  if (appId) { sql += ' AND app_id = ?'; params.push(appId); }
  if (userId) { sql += ' AND user_id = ?'; params.push(userId); }
  if (prefix) { sql += ' AND key LIKE ?'; params.push(`${prefix}%`); }

  sql += ' ORDER BY updated_at DESC LIMIT ?';
  params.push(limit);

  const result = await c.env.DB.prepare(sql).bind(...params).all();
  return c.json({ entries: result.results ?? [] });
});

contentAdminRoutes.get('/admin/kv/value', async (c) => {
  await requireAdmin(c);
  const appId = c.req.query('app');
  const userId = c.req.query('user');
  const key = c.req.query('key');
  if (!appId || !userId || !key) return c.json({ error: 'app, user, key required' }, 400);

  const row = await c.env.DB.prepare(
    'SELECT value FROM kv WHERE app_id = ? AND user_id = ? AND key = ?',
  ).bind(appId, userId, key).first<{ value: string }>();

  if (!row) return c.json({ error: 'not found' }, 404);
  return c.json({ value: JSON.parse(row.value) });
});

contentAdminRoutes.delete('/admin/kv', async (c) => {
  await requireAdmin(c);
  const appId = c.req.query('app');
  const userId = c.req.query('user');
  const key = c.req.query('key');
  if (!appId || !userId || !key) return c.json({ error: 'app, user, key required' }, 400);

  await c.env.DB.prepare(
    'DELETE FROM kv WHERE app_id = ? AND user_id = ? AND key = ?',
  ).bind(appId, userId, key).run();

  return c.json({ ok: true });
});

// ── Collections ─────────────────────────────────────────────────

contentAdminRoutes.get('/admin/collections', async (c) => {
  await requireAdmin(c);
  const appId = c.req.query('app') ?? '';
  const collection = c.req.query('collection') ?? '';
  const limit = Math.min(Number(c.req.query('limit') || 50), 200);

  let sql = 'SELECT id, app_id, collection, owner_id, data, created_at, updated_at FROM documents WHERE 1=1';
  const params: unknown[] = [];

  if (appId) { sql += ' AND app_id = ?'; params.push(appId); }
  if (collection) { sql += ' AND collection = ?'; params.push(collection); }

  sql += ' ORDER BY updated_at DESC LIMIT ?';
  params.push(limit);

  const result = await c.env.DB.prepare(sql).bind(...params).all();
  const docs = (result.results ?? []).map((r: Record<string, unknown>) => ({
    ...r,
    data: r.data ? JSON.parse(r.data as string) : null,
  }));
  return c.json({ documents: docs });
});

contentAdminRoutes.delete('/admin/collections', async (c) => {
  await requireAdmin(c);
  const appId = c.req.query('app');
  const collection = c.req.query('collection');
  const id = c.req.query('id');
  if (!appId || !collection || !id) return c.json({ error: 'app, collection, id required' }, 400);

  await c.env.DB.prepare(
    'DELETE FROM documents WHERE app_id = ? AND collection = ? AND id = ?',
  ).bind(appId, collection, id).run();

  return c.json({ ok: true });
});

// ── Counters ────────────────────────────────────────────────────

contentAdminRoutes.get('/admin/counters', async (c) => {
  await requireAdmin(c);
  const appId = c.req.query('app') ?? '';
  const prefix = c.req.query('prefix') ?? '';
  const limit = Math.min(Number(c.req.query('limit') || 100), 500);

  let sql = 'SELECT app_id, key as name, value FROM counters WHERE 1=1';
  const params: unknown[] = [];

  if (appId) { sql += ' AND app_id = ?'; params.push(appId); }
  if (prefix) { sql += ' AND key LIKE ?'; params.push(`${prefix}%`); }

  sql += ' ORDER BY app_id, key LIMIT ?';
  params.push(limit);

  const result = await c.env.DB.prepare(sql).bind(...params).all();
  return c.json({ counters: result.results ?? [] });
});

contentAdminRoutes.delete('/admin/counters', async (c) => {
  await requireAdmin(c);
  const appId = c.req.query('app');
  const name = c.req.query('name');
  if (!appId || !name) return c.json({ error: 'app, name required' }, 400);

  await c.env.DB.prepare(
    'DELETE FROM counters WHERE app_id = ? AND key = ?',
  ).bind(appId, name).run();

  return c.json({ ok: true });
});

// ── Users ───────────────────────────────────────────────────────

contentAdminRoutes.get('/admin/users', async (c) => {
  await requireAdmin(c);
  const limit = Math.min(Number(c.req.query('limit') || 50), 200);
  const offset = Number(c.req.query('offset') || 0);

  const result = await c.env.DB.prepare(
    'SELECT id, github_login, avatar_url, created_at FROM users ORDER BY created_at DESC LIMIT ? OFFSET ?',
  ).bind(limit, offset).all();

  const count = await c.env.DB.prepare('SELECT COUNT(*) as n FROM users').first<{ n: number }>();

  return c.json({ users: result.results ?? [], total: count?.n ?? 0 });
});

// ── Apps overview ───────────────────────────────────────────────

contentAdminRoutes.get('/admin/apps', async (c) => {
  await requireAdmin(c);

  const apps = await c.env.DB.prepare(
    'SELECT id, owner_login, store, category, oneliner, created_at FROM apps ORDER BY id ASC',
  ).all();

  return c.json({ apps: apps.results ?? [] });
});

// ── Stats ───────────────────────────────────────────────────────

contentAdminRoutes.get('/admin/stats', async (c) => {
  await requireAdmin(c);

  const [users, apps, kvEntries, docs, counters] = await Promise.all([
    c.env.DB.prepare('SELECT COUNT(*) as n FROM users').first<{ n: number }>(),
    c.env.DB.prepare('SELECT COUNT(*) as n FROM apps').first<{ n: number }>(),
    c.env.DB.prepare('SELECT COUNT(*) as n FROM kv').first<{ n: number }>(),
    c.env.DB.prepare('SELECT COUNT(*) as n FROM documents').first<{ n: number }>(),
    c.env.DB.prepare('SELECT COUNT(*) as n FROM counters').first<{ n: number }>(),
  ]);

  return c.json({
    users: users?.n ?? 0,
    apps: apps?.n ?? 0,
    kvEntries: kvEntries?.n ?? 0,
    documents: docs?.n ?? 0,
    counters: counters?.n ?? 0,
  });
});
