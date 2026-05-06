import { Hono } from 'hono';
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

/**
 * Reads the latest audit results. Public — anyone (creators, the
 * storefront, dashboards) can see drift over time. Filterable by
 * store + status so the storefront can show "this app last failed
 * on date X" without scanning the whole table.
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
  const sql =
    'SELECT app_id, store, check_name, status, detail, checked_at FROM audit_results' +
    (where.length ? ` WHERE ${where.join(' AND ')}` : '') +
    ' ORDER BY checked_at DESC, app_id ASC, check_name ASC';
  const result = await c.env.DB.prepare(sql).bind(...binds).all<AuditRow>();

  // camelCase output to match the rest of the v1 API.
  const checks = (result.results ?? []).map((r) => ({
    appId: r.app_id,
    store: r.store,
    checkName: r.check_name,
    status: r.status,
    detail: r.detail,
    checkedAt: r.checked_at,
  }));

  // Roll up to per-app summaries so the typical "show me apps with
  // any failure" query doesn't have to client-side group.
  const byApp = new Map<
    string,
    { appId: string; store: string; pass: number; warn: number; fail: number; checkedAt: number }
  >();
  for (const c of checks) {
    const key = c.appId;
    const cur = byApp.get(key) ?? {
      appId: c.appId,
      store: c.store,
      pass: 0,
      warn: 0,
      fail: 0,
      checkedAt: 0,
    };
    if (c.status === 'pass') cur.pass++;
    else if (c.status === 'warn') cur.warn++;
    else if (c.status === 'fail') cur.fail++;
    cur.checkedAt = Math.max(cur.checkedAt, c.checkedAt);
    byApp.set(key, cur);
  }

  return c.json({ summary: Array.from(byApp.values()), checks });
});
