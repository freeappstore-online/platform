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
 * GET  /v1/admin/agent-errors?limit=&since=&user=     — VibeCode errors across all sessions
 * GET  /v1/admin/agent-deploys?limit=&status=error    — failed deploys across all sessions
 * GET  /v1/admin/agent-sessions/:id                   — full session detail for debugging
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

  if (appId) {
    sql += ' AND app_id = ?';
    params.push(appId);
  }
  if (userId) {
    sql += ' AND user_id = ?';
    params.push(userId);
  }
  if (prefix) {
    sql += ' AND key LIKE ?';
    params.push(`${prefix}%`);
  }

  sql += ' ORDER BY updated_at DESC LIMIT ?';
  params.push(limit);

  const result = await c.env.DB.prepare(sql)
    .bind(...params)
    .all();
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
  )
    .bind(appId, userId, key)
    .first<{ value: string }>();

  if (!row) return c.json({ error: 'not found' }, 404);
  return c.json({ value: JSON.parse(row.value) });
});

contentAdminRoutes.delete('/admin/kv', async (c) => {
  await requireAdmin(c);
  const appId = c.req.query('app');
  const userId = c.req.query('user');
  const key = c.req.query('key');
  if (!appId || !userId || !key) return c.json({ error: 'app, user, key required' }, 400);

  await c.env.DB.prepare('DELETE FROM kv WHERE app_id = ? AND user_id = ? AND key = ?')
    .bind(appId, userId, key)
    .run();

  return c.json({ ok: true });
});

// ── Collections ─────────────────────────────────────────────────

contentAdminRoutes.get('/admin/collections', async (c) => {
  await requireAdmin(c);
  const appId = c.req.query('app') ?? '';
  const collection = c.req.query('collection') ?? '';
  const limit = Math.min(Number(c.req.query('limit') || 50), 200);

  let sql =
    'SELECT id, app_id, collection, owner_id, data, created_at, updated_at FROM documents WHERE 1=1';
  const params: unknown[] = [];

  if (appId) {
    sql += ' AND app_id = ?';
    params.push(appId);
  }
  if (collection) {
    sql += ' AND collection = ?';
    params.push(collection);
  }

  sql += ' ORDER BY updated_at DESC LIMIT ?';
  params.push(limit);

  const result = await c.env.DB.prepare(sql)
    .bind(...params)
    .all();
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

  await c.env.DB.prepare('DELETE FROM documents WHERE app_id = ? AND collection = ? AND id = ?')
    .bind(appId, collection, id)
    .run();

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

  if (appId) {
    sql += ' AND app_id = ?';
    params.push(appId);
  }
  if (prefix) {
    sql += ' AND key LIKE ?';
    params.push(`${prefix}%`);
  }

  sql += ' ORDER BY app_id, key LIMIT ?';
  params.push(limit);

  const result = await c.env.DB.prepare(sql)
    .bind(...params)
    .all();
  return c.json({ counters: result.results ?? [] });
});

contentAdminRoutes.delete('/admin/counters', async (c) => {
  await requireAdmin(c);
  const appId = c.req.query('app');
  const name = c.req.query('name');
  if (!appId || !name) return c.json({ error: 'app, name required' }, 400);

  await c.env.DB.prepare('DELETE FROM counters WHERE app_id = ? AND key = ?')
    .bind(appId, name)
    .run();

  return c.json({ ok: true });
});

// ── Users ───────────────────────────────────────────────────────

contentAdminRoutes.get('/admin/users', async (c) => {
  await requireAdmin(c);
  const limit = Math.min(Number(c.req.query('limit') || 50), 200);
  const offset = Number(c.req.query('offset') || 0);

  const result = await c.env.DB.prepare(
    'SELECT id, github_login, avatar_url, created_at FROM users ORDER BY created_at DESC LIMIT ? OFFSET ?',
  )
    .bind(limit, offset)
    .all();

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

// ── Agent sessions (VibeCode debugging) ─────────────────────────

/**
 * GET /v1/admin/agent-errors — recent errors across all VibeCode sessions.
 * Query: ?limit=50&since=<epoch_ms>&user=<user_id>
 */
contentAdminRoutes.get('/admin/agent-errors', async (c) => {
  await requireAdmin(c);
  const limit = Math.min(Number(c.req.query('limit') || 50), 200);
  const since = Number(c.req.query('since') || 0);
  const userId = c.req.query('user') ?? '';

  let sql = `SELECT session_id, user_id, name, app_id, errors, deploy_state, deploy_log, updated_at
     FROM agent_sessions WHERE errors IS NOT NULL AND errors != '[]'`;
  const binds: unknown[] = [];

  if (since) { sql += ' AND updated_at > ?'; binds.push(since); }
  if (userId) { sql += ' AND user_id = ?'; binds.push(userId); }
  sql += ' ORDER BY updated_at DESC LIMIT ?';
  binds.push(limit);

  const result = await c.env.DB.prepare(sql).bind(...binds).all();

  const sessions = (result.results ?? []).map((r: Record<string, unknown>) => ({
    sessionId: r.session_id,
    userId: r.user_id,
    name: r.name,
    appId: r.app_id,
    errors: r.errors ? JSON.parse(r.errors as string) : [],
    deployState: r.deploy_state ? JSON.parse(r.deploy_state as string) : null,
    deployLog: r.deploy_log ? JSON.parse(r.deploy_log as string) : [],
    updatedAt: r.updated_at,
  }));

  return c.json({ sessions });
});

/**
 * GET /v1/admin/agent-deploys — recent deploy failures across all sessions.
 * Query: ?limit=50&status=error
 */
contentAdminRoutes.get('/admin/agent-deploys', async (c) => {
  await requireAdmin(c);
  const limit = Math.min(Number(c.req.query('limit') || 50), 200);
  const statusFilter = c.req.query('status') ?? 'error';

  const result = await c.env.DB.prepare(
    `SELECT session_id, user_id, name, app_id, deploy_state, deploy_log, updated_at
     FROM agent_sessions WHERE deploy_state LIKE ? ORDER BY updated_at DESC LIMIT ?`,
  )
    .bind(`%"phase":"${statusFilter}"%`, limit)
    .all();

  const sessions = (result.results ?? []).map((r: Record<string, unknown>) => ({
    sessionId: r.session_id,
    userId: r.user_id,
    name: r.name,
    appId: r.app_id,
    deployState: r.deploy_state ? JSON.parse(r.deploy_state as string) : null,
    deployLog: r.deploy_log ? JSON.parse(r.deploy_log as string) : [],
    updatedAt: r.updated_at,
  }));

  return c.json({ sessions });
});

/**
 * GET /v1/admin/agent-sessions/:id — full session detail for debugging.
 */
contentAdminRoutes.get('/admin/agent-sessions/:id', async (c) => {
  await requireAdmin(c);
  const sessionId = c.req.param('id')!;

  const row = await c.env.DB.prepare('SELECT * FROM agent_sessions WHERE session_id = ?')
    .bind(sessionId)
    .first<Record<string, unknown>>();

  if (!row) return c.json({ session: null }, 404);

  return c.json({
    session: {
      id: row.session_id,
      userId: row.user_id,
      name: row.name,
      appId: row.app_id,
      appUrl: row.app_url,
      deployed: row.deployed === 1,
      messages: row.messages ? JSON.parse(row.messages as string) : [],
      deployState: row.deploy_state ? JSON.parse(row.deploy_state as string) : null,
      deployLog: row.deploy_log ? JSON.parse(row.deploy_log as string) : [],
      errors: row.errors ? JSON.parse(row.errors as string) : [],
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    },
  });
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
