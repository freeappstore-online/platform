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
 *
 * Internal routes (X-Internal-Token: ADMIN_PROVISION_TOKEN) — used by the
 * standalone admin worker which is already behind CF Access and cannot hold a
 * FAS user session JWT:
 *
 * GET    /v1/internal/admin/kv?app=&user=&prefix=&limit=
 * GET    /v1/internal/admin/kv/value?app=&user=&key=
 * DELETE /v1/internal/admin/kv?app=&user=&key=
 * GET    /v1/internal/admin/collections?app=&collection=&limit=
 * DELETE /v1/internal/admin/collections?app=&collection=&id=
 * GET    /v1/internal/admin/counters?app=&prefix=&limit=
 * DELETE /v1/internal/admin/counters?app=&name=
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
  return c.json({ value: parseJsonValue(row.value) });
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
    data: parseJsonObject(r.data),
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
    'SELECT id, github_login, display_name, email, provider, avatar_url, created_at FROM users ORDER BY created_at DESC LIMIT ? OFFSET ?',
  )
    .bind(limit, offset)
    .all();

  const count = await c.env.DB.prepare('SELECT COUNT(*) as n FROM users').first<{ n: number }>();

  return c.json({ users: result.results ?? [], total: count?.n ?? 0 });
});

// ── Apps overview ───────────────────────────────────────────────

contentAdminRoutes.get('/admin/apps', async (c) => {
  await requireAdmin(c);

  const [appRows, routeRows, sessionRows, userRows] = await Promise.all([
    c.env.DB.prepare(
      `SELECT id, owner_login, store, category, type, oneliner, repo, created_at
       FROM apps
       ORDER BY id ASC`,
    ).all<Record<string, unknown>>(),
    c.env.DB.prepare(
      `SELECT slug, zone, r2_prefix, store, hosted_on, created_at, updated_at
       FROM routes
       WHERE zone = 'freeappstore.online'
       ORDER BY slug ASC`,
    ).all<Record<string, unknown>>(),
    c.env.DB.prepare(
      `SELECT session_id, app_id, name, app_url, deployed, deploy_state, updated_at
       FROM agent_sessions
       WHERE app_id IS NOT NULL
       ORDER BY updated_at DESC`,
    ).all<Record<string, unknown>>(),
    c.env.DB.prepare(
      'SELECT github_login, display_name, avatar_url FROM users WHERE github_login IS NOT NULL',
    ).all<Record<string, unknown>>(),
  ]);

  const routesBySlug = new Map<string, Record<string, unknown>>();
  for (const route of routeRows.results ?? []) {
    const slug = stringValue(route.slug);
    if (slug) routesBySlug.set(slug, route);
  }

  const usersByLogin = new Map<string, Record<string, unknown>>();
  for (const user of userRows.results ?? []) {
    const login = stringValue(user.github_login);
    if (login) usersByLogin.set(login, user);
  }

  const sessionStats = new Map<string, { count: number; latest: Record<string, unknown> | null }>();
  for (const session of sessionRows.results ?? []) {
    const appId = stringValue(session.app_id);
    if (!appId) continue;
    const stat = sessionStats.get(appId) ?? { count: 0, latest: null };
    stat.count += 1;
    if (!stat.latest) stat.latest = session;
    sessionStats.set(appId, stat);
  }

  const combined = new Map<string, Record<string, unknown>>();
  for (const app of appRows.results ?? []) {
    const id = stringValue(app.id);
    if (!id) continue;
    combined.set(
      id,
      toAdminApp({
        id,
        app,
        route: routesBySlug.get(id) ?? null,
        user: usersByLogin.get(stringValue(app.owner_login) ?? '') ?? null,
        sessions: sessionStats.get(id) ?? null,
        inRegistry: true,
      }),
    );
  }

  for (const [slug, route] of routesBySlug) {
    if (combined.has(slug)) continue;
    combined.set(
      slug,
      toAdminApp({
        id: slug,
        app: null,
        route,
        user: null,
        sessions: sessionStats.get(slug) ?? null,
        inRegistry: false,
      }),
    );
  }

  const apps = Array.from(combined.values()).sort((a, b) => {
    const aUpdated = numberValue(a.updatedAt) ?? numberValue(a.createdAt) ?? 0;
    const bUpdated = numberValue(b.updatedAt) ?? numberValue(b.createdAt) ?? 0;
    return bUpdated - aUpdated || String(a.id).localeCompare(String(b.id));
  });

  return c.json({ apps });
});

contentAdminRoutes.get('/admin/creators', async (c) => {
  await requireAdmin(c);
  if (!c.env.ADMIN || !c.env.ADMIN_PROVISION_TOKEN) {
    return c.json(
      {
        error:
          'Admin worker binding is not configured. Add service binding ADMIN and ADMIN_PROVISION_TOKEN.',
      },
      503,
    );
  }

  const res = await c.env.ADMIN.fetch('https://admin.freeappstore.online/api/creators', {
    headers: { 'X-Internal-Token': c.env.ADMIN_PROVISION_TOKEN },
  });
  const text = await res.text();
  const body = parseJsonValue(text);
  if (!res.ok) {
    const detail = body && typeof body === 'object' && 'error' in body ? body.error : text;
    return c.json({ error: `Admin worker returned ${res.status}: ${String(detail)}` }, 502);
  }
  return c.json(Array.isArray(body) ? body : []);
});

function toAdminApp(input: {
  id: string;
  app: Record<string, unknown> | null;
  route: Record<string, unknown> | null;
  user: Record<string, unknown> | null;
  sessions: { count: number; latest: Record<string, unknown> | null } | null;
  inRegistry: boolean;
}) {
  const { id, app, route, user, sessions, inRegistry } = input;
  const latest = sessions?.latest ?? null;
  const domain = route
    ? `${stringValue(route.slug) ?? id}.${stringValue(route.zone) ?? 'freeappstore.online'}`
    : null;
  const store = normalizeStore(stringValue(app?.store) ?? stringValue(route?.store));
  const createdAt = numberValue(route?.created_at) ?? numberValue(app?.created_at) ?? null;
  const updatedAt = maxNumber(
    numberValue(route?.updated_at),
    numberValue(latest?.updated_at),
    createdAt,
  );

  return {
    id,
    name: stringValue(latest?.name) ?? stringValue(app?.oneliner) ?? id,
    store,
    category: stringValue(app?.category),
    type: stringValue(app?.type),
    oneliner: stringValue(app?.oneliner),
    repo: stringValue(app?.repo) ?? `freeappstore-online/${id}`,
    appUrl: stringValue(latest?.app_url) ?? (domain ? `https://${domain}` : null),
    domain,
    hostedOn: stringValue(route?.hosted_on) ?? (route ? 'r2' : 'missing-route'),
    hasRoute: !!route,
    r2Prefix: stringValue(route?.r2_prefix),
    inRegistry,
    owner: stringValue(app?.owner_login),
    ownerDisplayName: stringValue(user?.display_name),
    ownerAvatar: stringValue(user?.avatar_url),
    sessionCount: sessions?.count ?? 0,
    latestSession: latest
      ? {
          sessionId: stringValue(latest.session_id),
          name: stringValue(latest.name),
          appUrl: stringValue(latest.app_url),
          deployed: latest.deployed === 1 || latest.deployed === true,
          deployState: parseJsonObject(latest.deploy_state),
          updatedAt: numberValue(latest.updated_at),
        }
      : null,
    createdAt,
    updatedAt,
  };
}

function normalizeStore(value: string | null | undefined): string {
  const store = (value || 'apps').toLowerCase();
  return store === 'fas' ? 'apps' : store;
}

function stringValue(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value : null;
}

function numberValue(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim()) {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
    const parsedDate = Date.parse(value);
    if (Number.isFinite(parsedDate)) return parsedDate;
  }
  return null;
}

function maxNumber(...values: Array<number | null>): number | null {
  const numbers = values.filter((value): value is number => typeof value === 'number');
  return numbers.length ? Math.max(...numbers) : null;
}

function parseJsonObject(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'string') return null;
  try {
    const parsed = JSON.parse(value) as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

function parseJsonValue(value: unknown): unknown {
  if (!value || typeof value !== 'string') return null;
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return null;
  }
}

function parseJsonArray(value: unknown): unknown[] {
  if (!value || typeof value !== 'string') return [];
  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

// ── Agent sessions (VibeCode debugging) ─────────────────────────

/**
 * GET /v1/admin/agent-sessions — every user's VibeCode sessions.
 * Query: ?limit=50&offset=0&q=<search>
 */
contentAdminRoutes.get('/admin/agent-sessions', async (c) => {
  await requireAdmin(c);
  const limit = Math.min(Number(c.req.query('limit') || 50), 200);
  const offset = Number(c.req.query('offset') || 0);
  const q = (c.req.query('q') ?? '').trim();

  let sql = `SELECT
       s.session_id, s.user_id, s.name, s.app_id, s.app_url, s.deployed, s.deploy_state, s.created_at, s.updated_at,
       u.github_login, u.display_name
     FROM agent_sessions s
     LEFT JOIN users u ON u.id = s.user_id`;
  let countSql = 'SELECT COUNT(*) as n FROM agent_sessions s LEFT JOIN users u ON u.id = s.user_id';
  const binds: unknown[] = [];
  const countBinds: unknown[] = [];

  if (q) {
    sql +=
      ' WHERE s.name LIKE ? OR s.app_id LIKE ? OR s.session_id LIKE ? OR s.user_id LIKE ? OR u.github_login LIKE ? OR u.display_name LIKE ?';
    countSql +=
      ' WHERE s.name LIKE ? OR s.app_id LIKE ? OR s.session_id LIKE ? OR s.user_id LIKE ? OR u.github_login LIKE ? OR u.display_name LIKE ?';
    const like = `%${q.replace(/[%_]/g, '\\$&')}%`;
    binds.push(like, like, like, like, like, like);
    countBinds.push(like, like, like, like, like, like);
  }
  sql += ' ORDER BY s.updated_at DESC LIMIT ? OFFSET ?';
  binds.push(limit, offset);

  const [rows, count] = await Promise.all([
    c.env.DB.prepare(sql)
      .bind(...binds)
      .all<Record<string, unknown>>(),
    c.env.DB.prepare(countSql)
      .bind(...countBinds)
      .first<{ n: number }>(),
  ]);

  return c.json({
    sessions: (rows.results ?? []).map((r) => ({
      sessionId: r.session_id,
      userId: r.user_id,
      userLogin: r.github_login,
      userDisplayName: r.display_name,
      name: r.name,
      appId: r.app_id,
      appUrl: r.app_url,
      deployed: r.deployed === 1 || r.deployed === true,
      deployState: parseJsonObject(r.deploy_state),
      createdAt: r.created_at,
      updatedAt: r.updated_at,
    })),
    total: count?.n ?? 0,
    limit,
    offset,
  });
});

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

  if (since) {
    sql += ' AND updated_at > ?';
    binds.push(since);
  }
  if (userId) {
    sql += ' AND user_id = ?';
    binds.push(userId);
  }
  sql += ' ORDER BY updated_at DESC LIMIT ?';
  binds.push(limit);

  const result = await c.env.DB.prepare(sql)
    .bind(...binds)
    .all();

  const sessions = (result.results ?? []).map((r: Record<string, unknown>) => ({
    sessionId: r.session_id,
    userId: r.user_id,
    name: r.name,
    appId: r.app_id,
    errors: parseJsonArray(r.errors),
    deployState: parseJsonObject(r.deploy_state),
    deployLog: parseJsonArray(r.deploy_log),
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
    deployState: parseJsonObject(r.deploy_state),
    deployLog: parseJsonArray(r.deploy_log),
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

  const row = await c.env.DB.prepare(
    `SELECT s.*, u.github_login, u.display_name
     FROM agent_sessions s
     LEFT JOIN users u ON u.id = s.user_id
     WHERE s.session_id = ?`,
  )
    .bind(sessionId)
    .first<Record<string, unknown>>();

  if (!row) return c.json({ session: null }, 404);

  return c.json({
    session: {
      id: row.session_id,
      userId: row.user_id,
      userLogin: row.github_login,
      userDisplayName: row.display_name,
      name: row.name,
      appId: row.app_id,
      appUrl: row.app_url,
      deployed: row.deployed === 1,
      messages: parseJsonArray(row.messages),
      deployState: parseJsonObject(row.deploy_state),
      deployLog: parseJsonArray(row.deploy_log),
      errors: parseJsonArray(row.errors),
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

// ── Internal routes (X-Internal-Token) ─────────────────────────
// Used by the standalone admin worker (behind CF Access) which cannot hold
// a FAS user session JWT. Auth is the shared ADMIN_PROVISION_TOKEN.

function requireInternalToken(c: { env: Env; req: { header: (name: string) => string | undefined } }): boolean {
  const expected = c.env.ADMIN_PROVISION_TOKEN;
  const provided = c.req.header('X-Internal-Token');
  return !!expected && provided === expected;
}

contentAdminRoutes.get('/internal/admin/kv', async (c) => {
  if (!requireInternalToken(c)) return c.json({ error: 'unauthorized' }, 401);
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

contentAdminRoutes.get('/internal/admin/kv/value', async (c) => {
  if (!requireInternalToken(c)) return c.json({ error: 'unauthorized' }, 401);
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
  return c.json({ value: parseJsonValue(row.value) });
});

contentAdminRoutes.delete('/internal/admin/kv', async (c) => {
  if (!requireInternalToken(c)) return c.json({ error: 'unauthorized' }, 401);
  const appId = c.req.query('app');
  const userId = c.req.query('user');
  const key = c.req.query('key');
  if (!appId || !userId || !key) return c.json({ error: 'app, user, key required' }, 400);

  await c.env.DB.prepare('DELETE FROM kv WHERE app_id = ? AND user_id = ? AND key = ?')
    .bind(appId, userId, key)
    .run();
  return c.json({ ok: true });
});

contentAdminRoutes.get('/internal/admin/collections', async (c) => {
  if (!requireInternalToken(c)) return c.json({ error: 'unauthorized' }, 401);
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
    data: parseJsonObject(r.data),
  }));
  return c.json({ documents: docs });
});

contentAdminRoutes.delete('/internal/admin/collections', async (c) => {
  if (!requireInternalToken(c)) return c.json({ error: 'unauthorized' }, 401);
  const appId = c.req.query('app');
  const collection = c.req.query('collection');
  const id = c.req.query('id');
  if (!appId || !collection || !id) return c.json({ error: 'app, collection, id required' }, 400);

  await c.env.DB.prepare('DELETE FROM documents WHERE app_id = ? AND collection = ? AND id = ?')
    .bind(appId, collection, id)
    .run();
  return c.json({ ok: true });
});

contentAdminRoutes.get('/internal/admin/counters', async (c) => {
  if (!requireInternalToken(c)) return c.json({ error: 'unauthorized' }, 401);
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

contentAdminRoutes.delete('/internal/admin/counters', async (c) => {
  if (!requireInternalToken(c)) return c.json({ error: 'unauthorized' }, 401);
  const appId = c.req.query('app');
  const name = c.req.query('name');
  if (!appId || !name) return c.json({ error: 'app, name required' }, 400);

  await c.env.DB.prepare('DELETE FROM counters WHERE app_id = ? AND key = ?')
    .bind(appId, name)
    .run();
  return c.json({ ok: true });
});
