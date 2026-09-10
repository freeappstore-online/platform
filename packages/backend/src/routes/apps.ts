import { Hono } from 'hono';
import { HttpError, requireUser } from '../lib/auth.js';
import type { Env } from '../types.js';

export const appsRoutes = new Hono<{ Bindings: Env }>();

interface AppRow {
  id: string;
  owner_login: string;
  created_at: number;
  category: string | null;
  type: string | null;
  oneliner: string | null;
  repo: string | null;
  demo: string | null;
  store: string | null; // 'apps' | 'games'; nullable in case migration hasn't run
}

const STORE_DOMAIN: Record<string, { domain: string; org: string }> = {
  apps: { domain: 'freeappstore.online', org: 'freeappstore-online' },
  games: { domain: 'freegamestore.online', org: 'freegamestore-online' },
};

/**
 * Lists apps and games the authenticated user has provisioned. Read-only —
 * the source of truth is the row inserted on successful POST /v1/publish.
 *
 * Returns camelCase to match the rest of the v1 API. The CLI's `fas list`
 * is the primary consumer; web dashboards can also call this once we
 * build them.
 */
appsRoutes.get('/apps/mine', async (c) => {
  let user: Awaited<ReturnType<typeof requireUser>> | null = null;
  try {
    user = await requireUser(c);
  } catch (err) {
    if (err instanceof HttpError) return c.json({ error: err.message }, err.status as 401);
    throw err;
  }

  try {
    const result = await c.env.DB.prepare(
      `SELECT id, owner_login, created_at, category, type, oneliner, repo, demo, store
       FROM apps
       WHERE owner_login = ?
       ORDER BY created_at DESC`,
    )
      .bind(user.githubLogin)
      .all<AppRow>();

    const apps = (result.results ?? []).map((r) => {
      const store = r.store === 'games' ? 'games' : 'apps';
      const meta = STORE_DOMAIN[store]!;
      return {
        id: r.id,
        ownerLogin: r.owner_login,
        createdAt: r.created_at,
        store,
        category: r.category,
        type: r.type,
        oneliner: r.oneliner,
        repo: r.repo,
        demo: r.demo,
        appUrl: `https://${r.id}.${meta.domain}`,
        repoUrl: r.repo ? r.repo : `https://github.com/${meta.org}/${r.id}`,
      };
    });

    return c.json({ apps });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    const stack = err instanceof Error ? (err.stack ?? null) : null;
    console.error('[GET /apps/mine]', msg);
    try {
      await c.env.DB.prepare(
        `INSERT INTO error_log (ts, source, user_github, context, message, stack)
         VALUES (?, 'GET /apps/mine', ?, ?, ?, ?)`,
      )
        .bind(
          Date.now(),
          user.githubLogin || null,
          JSON.stringify({ path: c.req.path }),
          msg,
          stack ? stack.slice(0, 4000) : null,
        )
        .run();
    } catch {
      // error_log write must never mask the original error
    }
    throw err;
  }
});

/**
 * Public creator feed: `{ creators: { <appId>: <ownerLogin> } }` straight from
 * D1 (the source of truth). The storefront `registry.json` is a static file that
 * can drift from D1 on ownership changes; the reconcile script pulls this at
 * deploy time to re-sync `creatorGithub` without giving the storefront runtime
 * DB access. owner_login is already public (shown on every app page), so no auth.
 */
appsRoutes.get('/apps/creators', async (c) => {
  const result = await c.env.DB.prepare(
    "SELECT id, owner_login FROM apps WHERE store IS NULL OR store = 'apps'",
  ).all<{ id: string; owner_login: string }>();
  const creators: Record<string, string> = {};
  for (const r of result.results ?? []) {
    if (r.owner_login) creators[r.id] = r.owner_login;
  }
  return c.json({ creators }, 200, { 'Cache-Control': 'public, max-age=300' });
});

// ── Deploy status (#32) ────────────────────────────────────────────
//
// The console used to read GitHub's API directly from the browser, one
// unauthenticated request per app on every dashboard render. That rate-limits
// once a creator has more than a handful of apps, and an exhausted quota looks
// identical to "no deploys" — the badge simply vanished. These two routes put
// the call behind the authenticated backend, which reaches the admin Worker
// over the service binding; admin holds the GitHub token and caches the result.

/** Shape returned by admin's /api/apps/:id/deploy-status. */
interface AdminDeployStatus {
  status: string | null;
  conclusion: string | null;
  at: string | null;
  sha: string | null;
  url?: string | null;
  branch?: string | null;
  neverDeployed?: boolean;
}

async function adminFetch(env: Env, path: string): Promise<Response | null> {
  if (!env.ADMIN) return null;
  const res = await env.ADMIN.fetch(`https://admin${path}`, {
    headers: { 'X-Internal-Token': env.ADMIN_PROVISION_TOKEN ?? '' },
  });
  if (!res.ok) return null;
  return res;
}

/**
 * Deploy status for every app the caller owns, in one request.
 *
 * Scoped to the caller's own apps deliberately: admin's fan-out covers the
 * whole org, and proxying that wholesale would turn an authenticated endpoint
 * into a public map of every app's CI health.
 */
appsRoutes.get('/apps/deploy-status', async (c) => {
  let user: Awaited<ReturnType<typeof requireUser>>;
  try {
    user = await requireUser(c);
  } catch (err) {
    if (err instanceof HttpError) return c.json({ error: err.message }, err.status as 401);
    throw err;
  }

  const owned = await c.env.DB.prepare('SELECT id FROM apps WHERE owner_login = ?')
    .bind(user.githubLogin)
    .all<{ id: string }>();
  const ids = new Set((owned.results ?? []).map((r) => r.id));
  if (ids.size === 0) return c.json({ statuses: {} });

  const res = await adminFetch(c.env, '/api/apps/deploy-status');
  // Degrade to "unknown" rather than failing the dashboard: the badge is
  // decoration around the app list, not the app list itself.
  if (!res) return c.json({ statuses: {}, unavailable: true });

  const all = (await res.json().catch(() => ({}))) as Record<string, AdminDeployStatus>;
  const statuses: Record<string, AdminDeployStatus> = {};
  for (const [id, status] of Object.entries(all)) {
    if (ids.has(id)) statuses[id] = status;
  }
  return c.json({ statuses });
});

/** Latest deploy plus recent runs for one app the caller owns. */
appsRoutes.get('/apps/:id/deploy-status', async (c) => {
  let user: Awaited<ReturnType<typeof requireUser>>;
  try {
    user = await requireUser(c);
  } catch (err) {
    if (err instanceof HttpError) return c.json({ error: err.message }, err.status as 401);
    throw err;
  }

  const appId = c.req.param('id');
  const row = await c.env.DB.prepare('SELECT owner_login FROM apps WHERE id = ?')
    .bind(appId)
    .first<{ owner_login: string }>();
  if (!row) return c.json({ error: 'app not found' }, 404);
  if (row.owner_login !== user.githubLogin) return c.json({ error: 'not your app' }, 403);

  const res = await adminFetch(c.env, `/api/apps/${encodeURIComponent(appId)}/deploy-status`);
  if (!res) return c.json({ error: 'deploy status is unavailable' }, 503);
  return c.json((await res.json().catch(() => null)) ?? { error: 'bad response' });
});
