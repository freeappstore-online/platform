/**
 * App log ingestion — receives client-side logs from the SDK logger.
 *
 * POST /v1/apps/:appId/logs     — ingest a batch of log entries
 * GET  /v1/apps/:appId/logs     — query logs (owner only)
 * GET  /v1/apps/:appId/logs/build — latest build metadata
 */

import { Hono } from 'hono';
import { appExists } from '../lib/apps.js';
import { requireAppUser, requireConsoleAppOwner } from '../lib/auth.js';
import { parseJsonObject } from '../lib/json.js';
import { queryLimit } from '../lib/paging.js';
import { checkAndBump, d1UsageStore } from '../lib/proxy-rate-limit.js';
import type { Env } from '../types.js';

export const logsRoutes = new Hono<{ Bindings: Env }>();

const MAX_BATCH_SIZE = 100;
const MAX_ENTRY_SIZE = 4096;
const MAX_BUILD_SIZE = 4096;
const MAX_CATEGORY_LENGTH = 64;
const LEVELS = new Set(['debug', 'info', 'warn', 'error']);
/** Rows one user may write per day across every app (#490). */
export const DAILY_LOG_ROWS_PER_USER = 5000;

interface LogEntry {
  ts: number;
  level: string;
  category: string;
  message: string;
  data?: unknown;
  build?: Record<string, unknown>;
}

/**
 * Shape-check one client entry. The columns are typed (ts INTEGER, level one
 * of four values) and the owner dashboard filters on them, so anything else
 * is dropped rather than stored as free text.
 */
function isLogEntry(e: unknown): e is LogEntry {
  if (!e || typeof e !== 'object') return false;
  const r = e as Record<string, unknown>;
  return (
    typeof r.ts === 'number' &&
    Number.isFinite(r.ts) &&
    typeof r.level === 'string' &&
    LEVELS.has(r.level) &&
    (r.category === undefined || typeof r.category === 'string') &&
    typeof r.message === 'string' &&
    r.message.length > 0 &&
    (r.build === undefined || (typeof r.build === 'object' && r.build !== null))
  );
}

// ── Ingest (any authenticated user) ──────────────────────────────

logsRoutes.post('/apps/:appId/logs', async (c) => {
  const appId = c.req.param('appId')!;
  const user = await requireAppUser(c, appId);
  // Only real apps: otherwise any string is a bucket to fill.
  if (!(await appExists(c.env, appId))) return c.json({ ok: false, error: 'unknown app' }, 404);
  const body = await c.req.json<{ entries?: unknown[] }>().catch(() => null);
  if (!body?.entries || !Array.isArray(body.entries)) {
    return c.json({ ok: false, error: 'entries array required' }, 400);
  }

  const now = Date.now();
  const rows = body.entries
    .slice(0, MAX_BATCH_SIZE)
    .filter(isLogEntry)
    .map((e) => {
      const msg = e.message.slice(0, MAX_ENTRY_SIZE);
      const data = e.data ? JSON.stringify(e.data).slice(0, MAX_ENTRY_SIZE) : null;
      const build = e.build ? JSON.stringify(e.build) : null;
      return {
        ts: e.ts,
        level: e.level,
        category: (e.category ?? 'app').slice(0, MAX_CATEGORY_LENGTH),
        msg,
        data,
        build,
      };
    })
    // Build metadata is stored whole (it is parsed back as JSON), so an
    // oversized one can't be truncated — the entry is dropped instead.
    .filter((r) => !r.build || r.build.length <= MAX_BUILD_SIZE);

  if (rows.length === 0) return c.json({ ok: true, ingested: 0 });

  // Exact per-user daily row cap, charged per row so a batch of 100 can't
  // slip past as one event.
  const usage = await checkAndBump(d1UsageStore(c.env.DB), {
    appId: `logs-user:${user.id}`,
    dailyLimit: DAILY_LOG_ROWS_PER_USER,
    nowMs: now,
    denominator: 1,
    cost: rows.length,
  });
  if (!usage.allowed) {
    return c.json(
      {
        ok: false,
        error: `Daily log limit reached (${DAILY_LOG_ROWS_PER_USER} rows/day per user). Resets at midnight UTC.`,
      },
      429,
    );
  }

  const sql = `INSERT INTO app_logs (app_id, user_id, ts, level, category, message, data, build_meta, ingested_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`;
  await c.env.DB.batch(
    rows.map((r) =>
      c.env.DB.prepare(sql).bind(
        appId,
        user.id,
        r.ts,
        r.level,
        r.category,
        r.msg,
        r.data,
        r.build,
        now,
      ),
    ),
  );

  return c.json({ ok: true, ingested: rows.length });
});

// ── Query (owner only) ──────────────────────────────────────────

logsRoutes.get('/apps/:appId/logs', async (c) => {
  const appId = c.req.param('appId')!;
  await requireConsoleAppOwner(c, appId);

  const level = c.req.query('level');
  const category = c.req.query('category');
  const sinceRaw = c.req.query('since');
  const since = Number(sinceRaw);
  // Non-numeric limit is NaN, and Math.min(NaN, max) stays NaN, which D1 rejects.
  const limit = queryLimit(c.req.query('limit'), 100, 500);
  const userId = c.req.query('user_id');

  let sql =
    'SELECT ts, level, category, message, data, user_id, build_meta FROM app_logs WHERE app_id = ?';
  const params: unknown[] = [appId];

  if (level) {
    sql += ' AND level = ?';
    params.push(level);
  }
  if (category) {
    sql += ' AND category = ?';
    params.push(category);
  }
  // "abc" is a truthy query string, so it used to bind Number("abc") === NaN.
  if (sinceRaw && Number.isFinite(since)) {
    sql += ' AND ts >= ?';
    params.push(since);
  }
  if (userId) {
    sql += ' AND user_id = ?';
    params.push(userId);
  }

  sql += ' ORDER BY ts DESC LIMIT ?';
  params.push(limit);

  const result = await c.env.DB.prepare(sql)
    .bind(...params)
    .all();

  return c.json({
    logs: (result.results ?? []).map((r: Record<string, unknown>) => ({
      ts: r.ts,
      level: r.level,
      category: r.category,
      message: r.message,
      data: parseJsonObject(r.data) ?? undefined,
      userId: r.user_id,
      build: parseJsonObject(r.build_meta) ?? undefined,
    })),
  });
});

// ── Latest build info (owner only) ──────────────────────────────

logsRoutes.get('/apps/:appId/logs/build', async (c) => {
  const appId = c.req.param('appId')!;
  await requireConsoleAppOwner(c, appId);

  const row = await c.env.DB.prepare(
    `SELECT build_meta, ts FROM app_logs
     WHERE app_id = ? AND build_meta IS NOT NULL
     ORDER BY ts DESC LIMIT 1`,
  )
    .bind(appId)
    .first<{ build_meta: string; ts: number }>();

  if (!row) return c.json({ build: null });

  return c.json({
    build: parseJsonObject(row.build_meta),
    ts: row.ts,
  });
});
