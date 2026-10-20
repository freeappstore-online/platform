/**
 * App log ingestion — receives client-side logs from the SDK logger.
 *
 * POST /v1/apps/:appId/logs     — ingest a batch of log entries
 * GET  /v1/apps/:appId/logs     — query logs (owner only)
 * GET  /v1/apps/:appId/logs/build — latest build metadata
 */

import { Hono } from 'hono';
import { requireAppOwner, requireUser } from '../lib/auth.js';
import { parseJsonObject } from '../lib/json.js';
import { queryLimit } from '../lib/paging.js';
import type { Env } from '../types.js';

export const logsRoutes = new Hono<{ Bindings: Env }>();

const MAX_BATCH_SIZE = 100;
const MAX_ENTRY_SIZE = 4096;

interface LogEntry {
  ts: number;
  level: string;
  category: string;
  message: string;
  data?: unknown;
  build?: Record<string, unknown>;
}

// ── Ingest (any authenticated user) ──────────────────────────────

logsRoutes.post('/apps/:appId/logs', async (c) => {
  const user = await requireUser(c);

  const appId = c.req.param('appId')!;
  const body = await c.req.json<{ entries?: LogEntry[] }>().catch(() => null);
  if (!body?.entries || !Array.isArray(body.entries)) {
    return c.json({ ok: false, error: 'entries array required' }, 400);
  }

  const entries = body.entries.slice(0, MAX_BATCH_SIZE);
  const userId = (user as { id: string }).id;
  const now = Date.now();

  const stmt = c.env.DB.prepare(
    `INSERT INTO app_logs (app_id, user_id, ts, level, category, message, data, build_meta, ingested_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );

  const batch = entries
    .filter((e) => e.ts && e.level && e.message)
    .map((e) => {
      const msg = String(e.message).slice(0, MAX_ENTRY_SIZE);
      const data = e.data ? JSON.stringify(e.data).slice(0, MAX_ENTRY_SIZE) : null;
      const build = e.build ? JSON.stringify(e.build) : null;
      return stmt.bind(appId, userId, e.ts, e.level, e.category ?? 'app', msg, data, build, now);
    });

  if (batch.length > 0) {
    await c.env.DB.batch(batch);
  }

  return c.json({ ok: true, ingested: batch.length });
});

// ── Query (owner only) ──────────────────────────────────────────

logsRoutes.get('/apps/:appId/logs', async (c) => {
  const appId = c.req.param('appId')!;
  await requireAppOwner(c, appId);

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
  await requireAppOwner(c, appId);

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
