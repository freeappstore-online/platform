import { Hono } from 'hono';
import { HttpError, requireUser } from '../lib/auth.js';
import type { Env } from '../types.js';

/**
 * "I'm building this" claims on the storefront's App ideas page.
 *
 * One claim per platform user per idea (PRIMARY KEY (idea_id, user_id)).
 * Ideas live in the storefront's data, not here, so the id is only checked
 * for shape; a claim on an id the page doesn't show is simply never displayed.
 * Claims older than ACTIVE_DAYS stop counting so abandoned ones don't make an
 * idea look taken; claiming again refreshes the date.
 */
const IDEA_ID_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;
export const ACTIVE_DAYS = 90;
export const MAX_ACTIVE_CLAIMS = 10;
const RATE_LIMIT_WINDOW_S = 60;
const RATE_LIMIT_MAX = 10;

export const ideaBuildersRoutes = new Hono<{ Bindings: Env }>();

function activeSince(): number {
  return Math.floor(Date.now() / 1000) - ACTIVE_DAYS * 86400;
}

async function countFor(db: D1Database, ideaId: string): Promise<number> {
  const row = await db
    .prepare('SELECT COUNT(*) AS cnt FROM idea_builders WHERE idea_id = ? AND created_at > ?')
    .bind(ideaId, activeSince())
    .first<{ cnt: number }>();
  return row?.cnt ?? 0;
}

/**
 * GET /v1/store/idea-builders
 * Public: { builders: { [ideaId]: count } }. With a valid bearer token also
 * { mine: { [ideaId]: true } } — personal state, never publicly cached.
 */
ideaBuildersRoutes.get('/store/idea-builders', async (c) => {
  try {
    const since = activeSince();
    const { results } = await c.env.DB.prepare(
      'SELECT idea_id, COUNT(*) AS count FROM idea_builders WHERE created_at > ? GROUP BY idea_id',
    )
      .bind(since)
      .all<{ idea_id: string; count: number }>();
    const builders: Record<string, number> = {};
    for (const row of results ?? []) builders[row.idea_id] = row.count;
    if (!c.req.header('authorization')) {
      c.header('Cache-Control', 'public, max-age=60, stale-while-revalidate=300');
      return c.json({ builders });
    }
    const user = await requireUser(c);
    const { results: mineRows } = await c.env.DB.prepare(
      'SELECT idea_id FROM idea_builders WHERE user_id = ? AND created_at > ?',
    )
      .bind(user.id, since)
      .all<{ idea_id: string }>();
    const mine: Record<string, true> = {};
    for (const row of mineRows ?? []) mine[row.idea_id] = true;
    c.header('Cache-Control', 'private, no-store');
    c.header('Vary', 'Authorization');
    return c.json({ builders, mine });
  } catch (err) {
    if (err instanceof HttpError) return c.json({ error: err.message }, err.status as 401);
    throw err;
  }
});

/**
 * POST /v1/store/ideas/:ideaId/builder — claim (idempotent; refreshes the date).
 * Returns { building: true, count }.
 */
ideaBuildersRoutes.post('/store/ideas/:ideaId/builder', async (c) => {
  try {
    const user = await requireUser(c);
    const { ideaId } = c.req.param();
    if (!IDEA_ID_RE.test(ideaId)) return c.json({ error: 'bad idea id' }, 400);
    const now = Math.floor(Date.now() / 1000);
    const since = activeSince();

    const existing = await c.env.DB.prepare(
      'SELECT created_at FROM idea_builders WHERE idea_id = ? AND user_id = ?',
    )
      .bind(ideaId, user.id)
      .first<{ created_at: number }>();
    const alreadyActive = existing != null && existing.created_at > since;
    if (!alreadyActive) {
      const mine = await c.env.DB.prepare(
        'SELECT SUM(created_at > ?) AS active, SUM(created_at > ?) AS recent FROM idea_builders WHERE user_id = ?',
      )
        .bind(since, now - RATE_LIMIT_WINDOW_S, user.id)
        .first<{ active: number | null; recent: number | null }>();
      if ((mine?.recent ?? 0) >= RATE_LIMIT_MAX) {
        return c.json({ error: 'Too many claims at once. Try again in a minute.' }, 429);
      }
      if ((mine?.active ?? 0) >= MAX_ACTIVE_CLAIMS) {
        return c.json(
          { error: `You're building ${MAX_ACTIVE_CLAIMS} ideas already. Drop one first.` },
          409,
        );
      }
    }

    await c.env.DB.prepare(
      'INSERT INTO idea_builders (idea_id, user_id, created_at) VALUES (?, ?, ?) ON CONFLICT(idea_id, user_id) DO UPDATE SET created_at = excluded.created_at',
    )
      .bind(ideaId, user.id, now)
      .run();
    return c.json({ building: true, count: await countFor(c.env.DB, ideaId) });
  } catch (err) {
    if (err instanceof HttpError) return c.json({ error: err.message }, err.status as 401);
    throw err;
  }
});

/** DELETE /v1/store/ideas/:ideaId/builder — drop a claim (idempotent). */
ideaBuildersRoutes.delete('/store/ideas/:ideaId/builder', async (c) => {
  try {
    const user = await requireUser(c);
    const { ideaId } = c.req.param();
    if (!IDEA_ID_RE.test(ideaId)) return c.json({ error: 'bad idea id' }, 400);
    await c.env.DB.prepare('DELETE FROM idea_builders WHERE idea_id = ? AND user_id = ?')
      .bind(ideaId, user.id)
      .run();
    return c.json({ building: false, count: await countFor(c.env.DB, ideaId) });
  } catch (err) {
    if (err instanceof HttpError) return c.json({ error: err.message }, err.status as 401);
    throw err;
  }
});
