import { Hono } from 'hono';
import type { Env } from '../types.js';

export const uptimeRoutes = new Hono<{ Bindings: Env }>();

interface HealthCheckRow {
  target: string;
  url: string;
  ok: number;
  status: number | null;
  duration_ms: number;
  error: string | null;
  checked_at: number;
}

const RECENT_FAILURE_MS = 6 * 60 * 60 * 1000;

uptimeRoutes.get('/uptime', async (c) => {
  // Most recent result per target.
  const result = await c.env.DB.prepare(
    `SELECT target, url, ok, status, duration_ms, error, checked_at
     FROM health_checks
     WHERE id IN (
       SELECT MAX(id) FROM health_checks GROUP BY target
     )
     ORDER BY target`,
  ).all<HealthCheckRow>();

  const targets = result.results.map((r) => ({
    target: r.target,
    url: r.url,
    ok: r.ok === 1,
    status: r.status,
    durationMs: r.duration_ms,
    error: r.error,
    checkedAt: r.checked_at,
  }));

  // Every failed check in the window, so a scheduled reader that runs hours
  // apart (status-probe.yml) still sees a burst that failed and recovered (#642).
  const failed = await c.env.DB.prepare(
    `SELECT target, url, ok, status, duration_ms, error, checked_at
     FROM health_checks WHERE ok = 0 AND checked_at >= ?
     ORDER BY checked_at DESC LIMIT 50`,
  )
    .bind(Date.now() - RECENT_FAILURE_MS)
    .all<HealthCheckRow>();
  const recentFailures = failed.results.map((r) => ({
    target: r.target,
    url: r.url,
    status: r.status,
    error: r.error,
    checkedAt: r.checked_at,
  }));

  const allOk = targets.every((t) => t.ok);
  return c.json({ ok: allOk, targets, recentFailures });
});
