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
  let user;
  try {
    user = await requireUser(c);
  } catch (err) {
    if (err instanceof HttpError) return c.json({ error: err.message }, err.status as 401);
    throw err;
  }

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
});
