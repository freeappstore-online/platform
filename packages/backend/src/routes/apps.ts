import { Hono } from 'hono';
import type { Env } from '../types.js';
import { requireUser, HttpError } from '../lib/auth.js';

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
}

/**
 * Lists apps the authenticated user has provisioned. Read-only — the
 * source of truth is the row inserted on successful POST /v1/publish.
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
    if (err instanceof HttpError) return c.text(err.message, err.status as 401);
    throw err;
  }

  const result = await c.env.DB.prepare(
    `SELECT id, owner_login, created_at, category, type, oneliner, repo, demo
     FROM apps
     WHERE owner_login = ?
     ORDER BY created_at DESC`,
  )
    .bind(user.login)
    .all<AppRow>();

  const apps = (result.results ?? []).map((r) => ({
    id: r.id,
    ownerLogin: r.owner_login,
    createdAt: r.created_at,
    category: r.category,
    type: r.type,
    oneliner: r.oneliner,
    repo: r.repo,
    demo: r.demo,
    appUrl: `https://${r.id}.freeappstore.online`,
    repoUrl: r.repo ? r.repo : `https://github.com/freeappstore-online/${r.id}`,
  }));

  return c.json({ apps });
});
