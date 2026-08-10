import { Hono } from 'hono';
import { appExists } from '../lib/apps.js';
import { HttpError, requireUser } from '../lib/auth.js';
import type { Env } from '../types.js';

/**
 * Store-level app voting.
 *
 * Distinct from the app-developer `counters` primitive (which is scoped to
 * individual apps and writable by any authenticated user of that app).
 * These votes are owned by the platform: one vote per platform user per app,
 * enforced at the DB layer by PRIMARY KEY (app_id, user_id).
 */

/** Max votes a single user can cast across apps within a 60-second window. */
const RATE_LIMIT_WINDOW_S = 60;
const RATE_LIMIT_MAX = 10;

export const votesRoutes = new Hono<{ Bindings: Env }>();

/**
 * GET /v1/store/votes
 * Public — no auth required.
 * Returns aggregate vote counts for all apps: { votes: { [appId]: count } }
 */
votesRoutes.get('/store/votes', async (c) => {
  const { results } = await c.env.DB.prepare(
    'SELECT app_id, COUNT(*) AS count FROM app_votes GROUP BY app_id ORDER BY count DESC',
  ).all<{ app_id: string; count: number }>();

  const votes: Record<string, number> = {};
  for (const row of results ?? []) {
    votes[row.app_id] = row.count;
  }

  c.header('Cache-Control', 'public, max-age=60, stale-while-revalidate=300');
  return c.json({ votes });
});

/**
 * POST /v1/store/apps/:appId/vote
 * Auth required. Idempotent — voting twice is not an error.
 * Returns { voted: true, count: number }
 */
votesRoutes.post('/store/apps/:appId/vote', async (c) => {
  try {
    const user = await requireUser(c);
    const { appId } = c.req.param();

    if (!(await appExists(c.env, appId))) return c.text('unknown app', 404);

    // Soft rate limit: prevent a single user voting on >10 apps in 60 seconds.
    const windowStart = Math.floor(Date.now() / 1000) - RATE_LIMIT_WINDOW_S;
    const rateRow = await c.env.DB.prepare(
      'SELECT COUNT(*) AS cnt FROM app_votes WHERE user_id = ? AND created_at > ?',
    )
      .bind(user.id, windowStart)
      .first<{ cnt: number }>();

    // Check whether the user already voted for this specific app (existing votes
    // don't count against the rate limit — idempotent re-vote is fine).
    const alreadyVoted = await c.env.DB.prepare(
      'SELECT 1 FROM app_votes WHERE app_id = ? AND user_id = ?',
    )
      .bind(appId, user.id)
      .first();

    if (!alreadyVoted && (rateRow?.cnt ?? 0) >= RATE_LIMIT_MAX) {
      return c.json(
        { error: `rate limit: max ${RATE_LIMIT_MAX} votes per ${RATE_LIMIT_WINDOW_S}s` },
        429,
      );
    }

    // Idempotent insert — DO NOTHING if the row already exists.
    await c.env.DB.prepare(
      'INSERT INTO app_votes (app_id, user_id) VALUES (?, ?) ON CONFLICT(app_id, user_id) DO NOTHING',
    )
      .bind(appId, user.id)
      .run();

    const countRow = await c.env.DB.prepare(
      'SELECT COUNT(*) AS cnt FROM app_votes WHERE app_id = ?',
    )
      .bind(appId)
      .first<{ cnt: number }>();

    return c.json({ voted: true, count: countRow?.cnt ?? 0 });
  } catch (err) {
    if (err instanceof HttpError) return c.json({ error: err.message }, err.status as 401);
    throw err;
  }
});

/**
 * DELETE /v1/store/apps/:appId/vote
 * Auth required. Idempotent — deleting a non-existent vote returns 200.
 * Returns { voted: false, count: number }
 */
votesRoutes.delete('/store/apps/:appId/vote', async (c) => {
  try {
    const user = await requireUser(c);
    const { appId } = c.req.param();

    if (!(await appExists(c.env, appId))) return c.text('unknown app', 404);

    await c.env.DB.prepare('DELETE FROM app_votes WHERE app_id = ? AND user_id = ?')
      .bind(appId, user.id)
      .run();

    const countRow = await c.env.DB.prepare(
      'SELECT COUNT(*) AS cnt FROM app_votes WHERE app_id = ?',
    )
      .bind(appId)
      .first<{ cnt: number }>();

    return c.json({ voted: false, count: countRow?.cnt ?? 0 });
  } catch (err) {
    if (err instanceof HttpError) return c.json({ error: err.message }, err.status as 401);
    throw err;
  }
});
