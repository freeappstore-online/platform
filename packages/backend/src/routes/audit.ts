import { Hono } from 'hono';
import { runAudit } from '../lib/audit.js';
import { type CurrentUser, HttpError, isAdmin, requireConsoleUser } from '../lib/auth.js';
import { queryLimit, queryOffset } from '../lib/paging.js';
import { checkAndBump, d1UsageStore } from '../lib/proxy-rate-limit.js';
import type { Env } from '../types.js';

export const auditRoutes = new Hono<{ Bindings: Env }>();

interface AuditRow {
  app_id: string;
  store: string;
  check_name: string;
  status: string;
  detail: string | null;
  checked_at: number;
}

interface SummaryRow {
  app_id: string;
  store: string;
  pass: number;
  warn: number;
  fail: number;
  checked_at: number;
  n: number;
}

/**
 * Reads the latest audit results. Public — anyone (creators, the
 * storefront, dashboards) can see drift over time. Filterable by
 * store + status so the storefront can show "this app last failed
 * on date X" without scanning the whole table.
 *
 * `checks` is paged with ?limit= (default 100, max 500) and ?offset=;
 * `total` is the number of matching checks. `summary` always covers
 * every matching app.
 */
auditRoutes.get('/audit', async (c) => {
  const store = c.req.query('store');
  const status = c.req.query('status');
  const appId = c.req.query('app');

  const where: string[] = [];
  const binds: unknown[] = [];
  if (store === 'apps' || store === 'games') {
    where.push('store = ?');
    binds.push(store);
  }
  if (status === 'pass' || status === 'warn' || status === 'fail') {
    where.push('status = ?');
    binds.push(status);
  }
  if (appId) {
    where.push('app_id = ?');
    binds.push(appId);
  }
  const filter = where.length ? ` WHERE ${where.join(' AND ')}` : '';
  const limit = queryLimit(c.req.query('limit'), 100, 500);
  const offset = queryOffset(c.req.query('offset'));

  const [result, rollup] = await Promise.all([
    c.env.DB.prepare(
      `SELECT app_id, store, check_name, status, detail, checked_at FROM audit_results${filter} ORDER BY checked_at DESC, app_id ASC, check_name ASC LIMIT ? OFFSET ?`,
    )
      .bind(...binds, limit, offset)
      .all<AuditRow>(),
    // Per-app roll-up over every matching row, not just this page, so the
    // typical "show me apps with any failure" query doesn't have to page
    // through checks and group client-side. One row per (app, store).
    c.env.DB.prepare(
      `SELECT app_id, store, SUM(status = 'pass') AS pass, SUM(status = 'warn') AS warn, SUM(status = 'fail') AS fail, MAX(checked_at) AS checked_at, COUNT(*) AS n FROM audit_results${filter} GROUP BY app_id, store ORDER BY checked_at DESC, app_id ASC`,
    )
      .bind(...binds)
      .all<SummaryRow>(),
  ]);

  // camelCase output to match the rest of the v1 API.
  const checks = (result.results ?? []).map((r) => ({
    appId: r.app_id,
    store: r.store,
    checkName: r.check_name,
    status: r.status,
    detail: r.detail,
    checkedAt: r.checked_at,
  }));
  const rows = rollup.results ?? [];
  const summary = rows.map((r) => ({
    appId: r.app_id,
    store: r.store,
    pass: r.pass,
    warn: r.warn,
    fail: r.fail,
    checkedAt: r.checked_at,
  }));
  const total = rows.reduce((n, r) => n + r.n, 0);

  // Rows change on the weekly cron (`0 6 * * SUN`, index.ts scheduled) or a
  // rare manual /audit/run, so a short shared cache is safe.
  return c.json({ summary, checks, total }, 200, { 'Cache-Control': 'public, max-age=300' });
});

/** Manual audit runs allowed per day, platform-wide (#493). */
export const DAILY_AUDIT_RUNS = 24;

/**
 * Manually trigger an audit run. Mirrors the weekly cron (`0 6 * * SUN`
 * in wrangler.toml) but lets us populate the table immediately on first
 * deploy or after a registry change without waiting up to a week.
 *
 * Each invocation makes ~50 outgoing fetches, so it is for platform admins
 * and app owners (creators) only, and capped platform-wide per day (#493).
 */
auditRoutes.post('/audit/run', async (c) => {
  let user: CurrentUser;
  try {
    user = await requireConsoleUser(c);
  } catch (err) {
    if (err instanceof HttpError) return c.json({ error: err.message }, err.status as 401);
    throw err;
  }
  if (!isAdmin(user, c.env)) {
    const owns = user.githubLogin
      ? await c.env.DB.prepare('SELECT 1 FROM apps WHERE owner_login = ? COLLATE NOCASE LIMIT 1')
          .bind(user.githubLogin)
          .first()
      : null;
    if (!owns) return c.json({ error: 'app owners and admins only' }, 403);
  }
  const usage = await checkAndBump(d1UsageStore(c.env.DB), {
    appId: 'audit-run',
    dailyLimit: DAILY_AUDIT_RUNS,
    nowMs: Date.now(),
    denominator: 1,
  });
  if (!usage.allowed) {
    return c.json({ error: `Audit run limit reached (${DAILY_AUDIT_RUNS}/day).` }, 429);
  }
  const r = await runAudit(c.env.DB);
  return c.json({ scanned: r.scanned, failed: r.failed });
});
