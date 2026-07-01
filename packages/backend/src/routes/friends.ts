/**
 * Platform-level friends system. Once two users are friends, every app
 * on FreeAppStore can use that relationship.
 *
 * Data model: alphabetical pair ordering (user_a < user_b) so each
 * friendship is exactly one row.
 */

import { Hono } from 'hono';
import { HttpError, requireUser } from '../lib/auth.js';
import type { Env } from '../types.js';
import { dispatchWebhookPlatform } from './webhooks.js';

export const friendsRoutes = new Hono<{ Bindings: Env }>();

const MAX_FRIENDS = 200;
const MAX_PENDING_OUTGOING = 50;
const PENDING_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days
const SEARCH_RATE_LIMIT_MS = 2_000; // 1 search per 2s per user
const REQUEST_COOLDOWN_MS = 60_000; // 1 min cooldown after decline before re-requesting same user

const REQUEST_RATE_LIMIT_MS = 3_000; // 1 friend request per 3s per user
const MUTATION_RATE_LIMIT_MS = 1_000; // 1 accept/decline/block/delete per 1s per user

/** @internal Exported for test cleanup only. */
export const searchRateMap = new Map<string, number>();
export const requestCooldownMap = new Map<string, number>();
export const requestRateMap = new Map<string, number>();
export const mutationRateMap = new Map<string, number>();
const RATE_MAP_MAX = 5_000;

/** Evict stale entries to prevent memory leaks. Runs on every call. */
function pruneMap(map: Map<string, number>, maxAge: number): void {
  if (map.size === 0) return;
  const cutoff = Date.now() - maxAge;
  for (const [k, v] of map) {
    if (v < cutoff) map.delete(k);
  }
  // Hard cap — if still too large, clear everything
  if (map.size >= RATE_MAP_MAX) map.clear();
}

const MAX_USER_ID_LEN = 128;

function validateUserId(id: string): void {
  if (!id || id.length > MAX_USER_ID_LEN) {
    throw new HttpError(400, 'invalid userId');
  }
}

/** Order two IDs alphabetically so (user_a < user_b) always holds. */
function pair(a: string, b: string): [string, string] {
  return a < b ? [a, b] : [b, a];
}

interface FriendshipRow {
  user_a: string;
  user_b: string;
  status: string;
  initiator: string;
  blocker: string | null;
  created_at: number;
  updated_at: number;
}

interface UserRow {
  id: string;
  github_login: string;
  avatar_url: string | null;
  display_name: string | null;
}

// ── POST /friends/request ────────────────────────────────────────

friendsRoutes.post('/friends/request', async (c) => {
  const me = await requireUser(c);
  const body = await c.req.json<{ userId: string }>().catch(() => null);
  if (!body?.userId) throw new HttpError(400, 'userId required');
  validateUserId(body.userId);
  if (body.userId === me.id) throw new HttpError(400, 'cannot friend yourself');

  // Rate limit: 1 request per 3s — slows user-existence probing
  pruneMap(requestRateMap, REQUEST_RATE_LIMIT_MS);
  const lastReq = requestRateMap.get(me.id) ?? 0;
  if (Date.now() - lastReq < REQUEST_RATE_LIMIT_MS) {
    throw new HttpError(429, 'too many requests, slow down');
  }
  requestRateMap.set(me.id, Date.now());

  const target = await c.env.DB.prepare('SELECT id FROM users WHERE id = ?')
    .bind(body.userId)
    .first<{ id: string }>();
  if (!target) throw new HttpError(404, 'user not found');

  const [a, b] = pair(me.id, body.userId);
  const now = Date.now();

  // Check existing row
  const existing = await c.env.DB.prepare(
    'SELECT status, initiator, blocker FROM friendships WHERE user_a = ? AND user_b = ?',
  )
    .bind(a, b)
    .first<{ status: string; initiator: string; blocker: string | null }>();

  if (existing) {
    // Blocked — invisible
    if (existing.status === 'blocked') throw new HttpError(404, 'user not found');
    // Already friends
    if (existing.status === 'accepted') throw new HttpError(409, 'already friends');
    // Pending from me
    if (existing.status === 'pending' && existing.initiator === me.id) {
      throw new HttpError(409, 'request already sent');
    }
    // Pending from them — auto-accept (mutual request)
    if (existing.status === 'pending' && existing.initiator !== me.id) {
      // Enforce the accepter's friend cap here too (the INSERT-side cap below
      // only guards the initiator). Conditional UPDATE keeps it TOCTOU-safe.
      const acc = await c.env.DB.prepare(
        `UPDATE friendships SET status = 'accepted', updated_at = ?
         WHERE user_a = ? AND user_b = ? AND status = 'pending'
           AND (SELECT COUNT(*) FROM friendships WHERE (user_a = ? OR user_b = ?) AND status = 'accepted') < ?`,
      )
        .bind(now, a, b, me.id, me.id, MAX_FRIENDS)
        .run();
      if (!acc.meta.changes) throw new HttpError(409, `friend limit reached (${MAX_FRIENDS})`);
      await dispatchWebhookPlatform(c.env.DB, 'friend.accepted', {
        userId: me.id,
        friendId: body.userId,
      }).catch(() => {});
      return c.json({ status: 'accepted', autoAccepted: true });
    }
  }

  // Cooldown check: prevent re-requesting immediately after being declined
  pruneMap(requestCooldownMap, REQUEST_COOLDOWN_MS);
  const cooldownKey = `${me.id}:${body.userId}`;
  const cooldownUntil = requestCooldownMap.get(cooldownKey) ?? 0;
  if (now < cooldownUntil) {
    throw new HttpError(429, 'please wait before sending another request to this user');
  }

  // Check limits + insert atomically via conditional INSERT to close TOCTOU gap.
  // The INSERT only succeeds if both counts are under their limits.
  try {
    const pendingCutoff = now - PENDING_TTL_MS;
    const result = await c.env.DB.prepare(
      `INSERT INTO friendships (user_a, user_b, status, initiator, created_at, updated_at)
       SELECT ?, ?, 'pending', ?, ?, ?
       WHERE (SELECT COUNT(*) FROM friendships WHERE (user_a = ? OR user_b = ?) AND status = 'accepted') < ?
         AND (SELECT COUNT(*) FROM friendships WHERE (user_a = ? OR user_b = ?) AND status = 'pending' AND initiator = ? AND created_at > ?) < ?`,
    )
      .bind(
        a,
        b,
        me.id,
        now,
        now,
        me.id,
        me.id,
        MAX_FRIENDS,
        me.id,
        me.id,
        me.id,
        pendingCutoff,
        MAX_PENDING_OUTGOING,
      )
      .run();
    if (!result.meta.changes) {
      // INSERT matched 0 rows — one of the limits was hit. Check which.
      const friendCount = await c.env.DB.prepare(
        `SELECT COUNT(*) AS n FROM friendships WHERE (user_a = ? OR user_b = ?) AND status = 'accepted'`,
      )
        .bind(me.id, me.id)
        .first<{ n: number }>();
      if ((friendCount?.n ?? 0) >= MAX_FRIENDS) {
        throw new HttpError(409, `friend limit reached (${MAX_FRIENDS})`);
      }
      throw new HttpError(409, `too many pending requests (max ${MAX_PENDING_OUTGOING})`);
    }
  } catch (err: unknown) {
    // Race condition: both users requested simultaneously
    const msg = err instanceof Error ? err.message : '';
    if (msg.includes('UNIQUE') || msg.includes('PRIMARY')) {
      // Re-read and auto-accept
      const row = await c.env.DB.prepare(
        'SELECT status, initiator FROM friendships WHERE user_a = ? AND user_b = ?',
      )
        .bind(a, b)
        .first<{ status: string; initiator: string }>();
      if (row?.status === 'pending' && row.initiator !== me.id) {
        const acc = await c.env.DB.prepare(
          `UPDATE friendships SET status = 'accepted', updated_at = ?
           WHERE user_a = ? AND user_b = ? AND status = 'pending'
             AND (SELECT COUNT(*) FROM friendships WHERE (user_a = ? OR user_b = ?) AND status = 'accepted') < ?`,
        )
          .bind(now, a, b, me.id, me.id, MAX_FRIENDS)
          .run();
        if (!acc.meta.changes) throw new HttpError(409, `friend limit reached (${MAX_FRIENDS})`);
        await dispatchWebhookPlatform(c.env.DB, 'friend.accepted', {
          userId: me.id,
          friendId: body.userId,
        }).catch(() => {});
        return c.json({ status: 'accepted', autoAccepted: true });
      }
      throw new HttpError(409, 'request already exists');
    }
    throw err;
  }

  await dispatchWebhookPlatform(c.env.DB, 'friend.requested', {
    userId: me.id,
    friendId: body.userId,
  }).catch(() => {});
  return c.json({ status: 'pending', autoAccepted: false });
});

// ── GET /friends ──────────────────────────────────────────────────

friendsRoutes.get('/friends', async (c) => {
  const me = await requireUser(c);
  const statusFilter = c.req.query('status') || 'accepted';
  const limit = Math.min(Math.max(parseInt(c.req.query('limit') ?? '200', 10) || 200, 1), 200);
  const offset = Math.max(parseInt(c.req.query('offset') ?? '0', 10) || 0, 0);

  let sql: string;
  let params: unknown[];

  const pendingCutoff = Date.now() - PENDING_TTL_MS;

  if (statusFilter === 'pending_incoming') {
    sql = `SELECT f.*, u.github_login, u.avatar_url, u.display_name,
             CASE WHEN f.user_a = ? THEN f.user_b ELSE f.user_a END AS friend_id
           FROM friendships f
           JOIN users u ON u.id = CASE WHEN f.user_a = ? THEN f.user_b ELSE f.user_a END
           WHERE (f.user_a = ? OR f.user_b = ?) AND f.status = 'pending' AND f.initiator != ?
             AND f.created_at > ?
           ORDER BY f.updated_at DESC LIMIT ? OFFSET ?`;
    params = [me.id, me.id, me.id, me.id, me.id, pendingCutoff, limit, offset];
  } else if (statusFilter === 'pending_outgoing') {
    sql = `SELECT f.*, u.github_login, u.avatar_url, u.display_name,
             CASE WHEN f.user_a = ? THEN f.user_b ELSE f.user_a END AS friend_id
           FROM friendships f
           JOIN users u ON u.id = CASE WHEN f.user_a = ? THEN f.user_b ELSE f.user_a END
           WHERE (f.user_a = ? OR f.user_b = ?) AND f.status = 'pending' AND f.initiator = ?
             AND f.created_at > ?
           ORDER BY f.updated_at DESC LIMIT ? OFFSET ?`;
    params = [me.id, me.id, me.id, me.id, me.id, pendingCutoff, limit, offset];
  } else {
    // accepted (default)
    sql = `SELECT f.*, u.github_login, u.avatar_url, u.display_name,
             CASE WHEN f.user_a = ? THEN f.user_b ELSE f.user_a END AS friend_id
           FROM friendships f
           JOIN users u ON u.id = CASE WHEN f.user_a = ? THEN f.user_b ELSE f.user_a END
           WHERE (f.user_a = ? OR f.user_b = ?) AND f.status = 'accepted'
           ORDER BY f.updated_at DESC LIMIT ? OFFSET ?`;
    params = [me.id, me.id, me.id, me.id, limit, offset];
  }

  const stmt = c.env.DB.prepare(sql);
  const { results } = await stmt.bind(...params).all<
    FriendshipRow & {
      friend_id: string;
      github_login: string;
      avatar_url: string | null;
      display_name: string | null;
    }
  >();

  const friends = (results ?? []).map((r) => ({
    userId: r.friend_id,
    login: r.display_name || r.github_login,
    avatarUrl: r.avatar_url,
    status: r.status,
    since: r.status === 'accepted' ? r.updated_at : r.created_at,
  }));

  return c.json({ friends });
});

// ── PATCH /friends/:userId ────────────────────────────────────────

friendsRoutes.patch('/friends/:userId', async (c) => {
  const me = await requireUser(c);
  const targetId = c.req.param('userId');
  validateUserId(targetId);
  const body = await c.req.json<{ action: string }>().catch(() => null);
  if (!body?.action) throw new HttpError(400, 'action required');

  pruneMap(mutationRateMap, MUTATION_RATE_LIMIT_MS);
  const lastMut = mutationRateMap.get(me.id) ?? 0;
  if (Date.now() - lastMut < MUTATION_RATE_LIMIT_MS) {
    throw new HttpError(429, 'too many requests, slow down');
  }
  mutationRateMap.set(me.id, Date.now());

  const [a, b] = pair(me.id, targetId);
  const now = Date.now();

  if (body.action === 'accept') {
    const row = await c.env.DB.prepare(
      'SELECT status, initiator FROM friendships WHERE user_a = ? AND user_b = ?',
    )
      .bind(a, b)
      .first<{ status: string; initiator: string }>();
    if (!row || row.status !== 'pending') throw new HttpError(404, 'no pending request');
    if (row.initiator === me.id) throw new HttpError(400, 'cannot accept your own request');

    const acc = await c.env.DB.prepare(
      `UPDATE friendships SET status = 'accepted', updated_at = ?
       WHERE user_a = ? AND user_b = ? AND status = 'pending'
         AND (SELECT COUNT(*) FROM friendships WHERE (user_a = ? OR user_b = ?) AND status = 'accepted') < ?`,
    )
      .bind(now, a, b, me.id, me.id, MAX_FRIENDS)
      .run();
    if (!acc.meta.changes) throw new HttpError(409, `friend limit reached (${MAX_FRIENDS})`);
    await dispatchWebhookPlatform(c.env.DB, 'friend.accepted', {
      userId: me.id,
      friendId: targetId,
    }).catch(() => {});
    return c.json({ ok: true, status: 'accepted' });
  }

  if (body.action === 'decline') {
    const row = await c.env.DB.prepare(
      'SELECT status, initiator FROM friendships WHERE user_a = ? AND user_b = ?',
    )
      .bind(a, b)
      .first<{ status: string; initiator: string }>();
    if (!row || row.status !== 'pending') throw new HttpError(404, 'no pending request');
    if (row.initiator === me.id) throw new HttpError(400, 'use DELETE to cancel your own request');

    await c.env.DB.prepare('DELETE FROM friendships WHERE user_a = ? AND user_b = ?')
      .bind(a, b)
      .run();
    // Set cooldown so the declined user can't immediately re-request
    const declinedUser = row.initiator;
    requestCooldownMap.set(`${declinedUser}:${me.id}`, now + REQUEST_COOLDOWN_MS);
    return c.json({ ok: true });
  }

  if (body.action === 'block') {
    // If already blocked by either party, don't overwrite the blocker —
    // prevents the blocked user from hijacking unblock control.
    const existing = await c.env.DB.prepare(
      'SELECT status FROM friendships WHERE user_a = ? AND user_b = ?',
    )
      .bind(a, b)
      .first<{ status: string }>();
    if (existing?.status === 'blocked') {
      return c.json({ ok: true, status: 'blocked' });
    }

    // Block from any non-blocked state — upsert.
    // ON CONFLICT preserves the first blocker if a race sets status='blocked'
    // between our SELECT and this UPSERT (prevents blocker hijack via race).
    await c.env.DB.prepare(
      `INSERT INTO friendships (user_a, user_b, status, initiator, blocker, created_at, updated_at)
       VALUES (?, ?, 'blocked', ?, ?, ?, ?)
       ON CONFLICT(user_a, user_b) DO UPDATE SET
         status = 'blocked',
         blocker = CASE WHEN friendships.status = 'blocked' THEN friendships.blocker ELSE ? END,
         updated_at = ?`,
    )
      .bind(a, b, me.id, me.id, now, now, me.id, now)
      .run();
    await dispatchWebhookPlatform(c.env.DB, 'friend.blocked', {
      userId: me.id,
      blockedId: targetId,
    }).catch(() => {});
    return c.json({ ok: true, status: 'blocked' });
  }

  throw new HttpError(400, 'action must be accept, decline, or block');
});

// ── DELETE /friends/:userId ───────────────────────────────────────

friendsRoutes.delete('/friends/:userId', async (c) => {
  const me = await requireUser(c);
  const targetId = c.req.param('userId');
  validateUserId(targetId);

  pruneMap(mutationRateMap, MUTATION_RATE_LIMIT_MS);
  const lastMut = mutationRateMap.get(me.id) ?? 0;
  if (Date.now() - lastMut < MUTATION_RATE_LIMIT_MS) {
    throw new HttpError(429, 'too many requests, slow down');
  }
  mutationRateMap.set(me.id, Date.now());

  const [a, b] = pair(me.id, targetId);

  const row = await c.env.DB.prepare(
    'SELECT status, initiator, blocker FROM friendships WHERE user_a = ? AND user_b = ?',
  )
    .bind(a, b)
    .first<{ status: string; initiator: string; blocker: string | null }>();
  if (!row) throw new HttpError(404, 'no friendship found');

  // Blocked — only the blocker can unblock (delete)
  if (row.status === 'blocked') {
    if (row.blocker !== me.id) throw new HttpError(403, 'only the blocker can unblock');
  }

  // Pending — only the initiator can cancel
  if (row.status === 'pending' && row.initiator !== me.id) {
    throw new HttpError(400, 'use PATCH with decline to reject an incoming request');
  }

  await c.env.DB.prepare('DELETE FROM friendships WHERE user_a = ? AND user_b = ?')
    .bind(a, b)
    .run();

  if (row.status === 'accepted') {
    await dispatchWebhookPlatform(c.env.DB, 'friend.removed', {
      userId: me.id,
      friendId: targetId,
    }).catch(() => {});
  }
  return c.json({ ok: true });
});

// ── GET /friends/check/:userId ────────────────────────────────────

friendsRoutes.get('/friends/check/:userId', async (c) => {
  const me = await requireUser(c);
  const targetId = c.req.param('userId');
  validateUserId(targetId);
  const [a, b] = pair(me.id, targetId);

  const row = await c.env.DB.prepare(
    'SELECT status, blocker, initiator FROM friendships WHERE user_a = ? AND user_b = ?',
  )
    .bind(a, b)
    .first<{ status: string; blocker: string | null; initiator: string }>();

  if (!row) return c.json({ status: 'none' });
  if (row.status === 'blocked' && row.blocker !== me.id) return c.json({ status: 'none' });
  if (row.status === 'blocked' && row.blocker === me.id)
    return c.json({ status: 'blocked_by_you' });
  if (row.status === 'pending' && row.initiator === me.id)
    return c.json({ status: 'pending_outgoing' });
  if (row.status === 'pending' && row.initiator !== me.id)
    return c.json({ status: 'pending_incoming' });
  return c.json({ status: row.status });
});

// ── GET /friends/search ───────────────────────────────────────────

friendsRoutes.get('/friends/search', async (c) => {
  const me = await requireUser(c);
  const q = (c.req.query('q') ?? '').trim();
  if (q.length < 3) throw new HttpError(400, 'query must be at least 3 characters');
  if (q.length > 50) throw new HttpError(400, 'query too long');

  // Rate limit: 1 search per 2s per user (after input validation so bad
  // requests get a proper 400 without consuming rate-limit tokens)
  pruneMap(searchRateMap, SEARCH_RATE_LIMIT_MS);
  const lastSearch = searchRateMap.get(me.id) ?? 0;
  if (Date.now() - lastSearch < SEARCH_RATE_LIMIT_MS) {
    throw new HttpError(429, 'too many searches, try again shortly');
  }
  searchRateMap.set(me.id, Date.now());

  // Escape LIKE special chars
  const escaped = q.replace(/\\/g, '\\\\').replace(/%/g, '\\%').replace(/_/g, '\\_');

  const { results } = await c.env.DB.prepare(
    `SELECT id, github_login, avatar_url, display_name FROM users
     WHERE github_login LIKE ? ESCAPE '\\' AND id != ?
     LIMIT 10`,
  )
    .bind(`%${escaped}%`, me.id)
    .all<UserRow>();

  // For each result, check friendship status + filter out users who blocked me
  const users = [];
  for (const u of results ?? []) {
    const [a, b] = pair(me.id, u.id);
    const friendship = await c.env.DB.prepare(
      'SELECT status, blocker, initiator FROM friendships WHERE user_a = ? AND user_b = ?',
    )
      .bind(a, b)
      .first<{ status: string; blocker: string | null; initiator: string }>();

    // Skip users who blocked the searcher
    if (friendship?.status === 'blocked' && friendship.blocker !== me.id) continue;

    let friendStatus = 'none';
    if (friendship) {
      if (friendship.status === 'blocked') friendStatus = 'blocked_by_you';
      else if (friendship.status === 'pending' && friendship.initiator === me.id)
        friendStatus = 'pending_outgoing';
      else if (friendship.status === 'pending') friendStatus = 'pending_incoming';
      else friendStatus = friendship.status;
    }

    users.push({
      userId: u.id,
      login: u.display_name || u.github_login,
      avatarUrl: u.avatar_url,
      friendStatus,
    });
  }

  return c.json({ users });
});
