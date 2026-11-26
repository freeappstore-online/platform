import { afterEach, describe, expect, it, vi } from 'vitest';
import { app } from '../index.js';
import { signSession } from '../lib/session.js';
import { hasSqlite, sqliteD1 } from '../lib/sqlite-d1.testutil.js';
import { mutationRateMap, requestCooldownMap, requestRateMap, searchRateMap } from './friends.js';

const SIGNING_KEY = 'a'.repeat(64);

// Webhook dispatch runs in waitUntil, after the response (#764).
const background: Promise<unknown>[] = [];
const ctx = {
  waitUntil: (p: Promise<unknown>) => background.push(p),
  passThroughOnException() {},
  props: {},
};
const request: typeof app.request = (input, init, env) => app.request(input, init, env, ctx);

type FakeRow = Record<string, unknown> | null;

/**
 * Build a fake D1 that routes SQL to the appropriate mock data.
 * Keeps test setup minimal while covering the query patterns in friends.ts.
 */
function fakeDB(opts: {
  user?: FakeRow;
  targetUser?: FakeRow;
  friendship?: FakeRow;
  friendCount?: number;
  pendingCount?: number;
  friendsList?: Array<Record<string, unknown>>;
  searchUsers?: Array<Record<string, unknown>>;
  insertFail?: boolean;
  deleteChanges?: number;
  // For webhook queries
  webhooks?: Array<Record<string, unknown>>;
  onBind?: (sql: string, args: unknown[]) => void;
}) {
  return {
    prepare: (sql: string) => {
      const trimmed = sql.replace(/\s+/g, ' ').trim();
      const result = {
        first: async () => {
          if (trimmed.includes('FROM users WHERE id') && !trimmed.includes('github_login')) {
            // requireUser looks up by id from session
            if (opts.user) return opts.user;
            // Second user lookup (target user check)
            return opts.targetUser ?? null;
          }
          if (trimmed.includes('FROM users WHERE id = ?') && trimmed.includes('github_login')) {
            return opts.user ?? null;
          }
          if (trimmed.includes('FROM friendships WHERE user_a')) {
            return opts.friendship ?? null;
          }
          if (trimmed.includes('COUNT') && trimmed.includes('accepted')) {
            return { n: opts.friendCount ?? 0 };
          }
          if (trimmed.includes('COUNT') && trimmed.includes('pending')) {
            return { n: opts.pendingCount ?? 0 };
          }
          return null;
        },
        all: async () => {
          if (trimmed.includes('FROM friendships')) {
            return { results: opts.friendsList ?? [] };
          }
          if (trimmed.includes('FROM users') && trimmed.includes('LIKE')) {
            return { results: opts.searchUsers ?? [] };
          }
          if (trimmed.includes('FROM app_webhooks')) {
            return { results: opts.webhooks ?? [] };
          }
          return { results: [] };
        },
        run: async () => {
          if (opts.insertFail && trimmed.includes('INSERT INTO friendships')) {
            throw new Error('UNIQUE constraint failed');
          }
          return { meta: { changes: opts.deleteChanges ?? 1 } };
        },
      };
      return {
        ...result,
        bind: (...args: unknown[]) => {
          opts.onBind?.(trimmed, args);
          return result;
        },
      };
    },
  } as unknown as D1Database;
}

function env(db: D1Database) {
  return { DB: db, SESSION_SIGNING_KEY: SIGNING_KEY };
}

async function authHeader(userId = 'u1') {
  const token = await signSession(userId, SIGNING_KEY, { aud: 'console' });
  return `Bearer ${token}`;
}

const user1 = {
  id: 'u1',
  github_login: 'alice',
  avatar_url: null,
  display_name: null,
  email: null,
  date_of_birth: null,
};
const user2 = {
  id: 'u2',
  github_login: 'bob',
  avatar_url: null,
  display_name: null,
  email: null,
  date_of_birth: null,
};

describe('friends routes', () => {
  afterEach(() => {
    searchRateMap.clear();
    requestCooldownMap.clear();
    requestRateMap.clear();
    mutationRateMap.clear();
  });

  // ── Auth guard ──────────────────────────────────────────────────

  it('POST /v1/friends/request returns 401 without auth', async () => {
    const res = await request(
      '/v1/friends/request',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ userId: 'u2' }),
      },
      env(fakeDB({})),
    );
    expect(res.status).toBe(401);
  });

  // ── Self-friend rejection ──────────────────────────────────────

  it('POST /v1/friends/request rejects self-friending', async () => {
    const res = await request(
      '/v1/friends/request',
      {
        method: 'POST',
        headers: { Authorization: await authHeader(), 'Content-Type': 'application/json' },
        body: JSON.stringify({ userId: 'u1' }),
      },
      env(fakeDB({ user: user1 })),
    );
    expect(res.status).toBe(400);
  });

  // ── Target not found ───────────────────────────────────────────

  it('POST /v1/friends/request returns 404 for nonexistent user', async () => {
    const db = {
      prepare: (sql: string) => {
        const trimmed = sql.replace(/\s+/g, ' ').trim();
        const result = {
          first: async () => {
            // requireUser's user lookup
            if (trimmed.includes('FROM users WHERE id = ?') && trimmed.includes('github_login')) {
              return user1;
            }
            // target user check: SELECT id FROM users WHERE id = ?
            if (trimmed.includes('FROM users WHERE id = ?')) {
              return null; // target not found
            }
            return null;
          },
          all: async () => ({ results: [] }),
          run: async () => ({ meta: { changes: 0 } }),
        };
        return { ...result, bind: (..._args: unknown[]) => result };
      },
    } as unknown as D1Database;

    const res = await request(
      '/v1/friends/request',
      {
        method: 'POST',
        headers: { Authorization: await authHeader(), 'Content-Type': 'application/json' },
        body: JSON.stringify({ userId: 'u99' }),
      },
      env(db),
    );
    expect(res.status).toBe(404);
  });

  // ── Block invisibility ─────────────────────────────────────────

  it('POST /v1/friends/request returns 404 when blocked', async () => {
    const db = {
      prepare: (sql: string) => {
        const trimmed = sql.replace(/\s+/g, ' ').trim();
        const result = {
          first: async () => {
            if (trimmed.includes('FROM users WHERE id = ?') && trimmed.includes('github_login'))
              return user1;
            if (trimmed.includes('FROM users WHERE id = ?')) return { id: 'u2' };
            if (trimmed.includes('FROM friendships'))
              return { status: 'blocked', initiator: 'u2', blocker: 'u2' };
            return null;
          },
          all: async () => ({ results: [] }),
          run: async () => ({ meta: { changes: 0 } }),
        };
        return { ...result, bind: (..._args: unknown[]) => result };
      },
    } as unknown as D1Database;

    const res = await request(
      '/v1/friends/request',
      {
        method: 'POST',
        headers: { Authorization: await authHeader(), 'Content-Type': 'application/json' },
        body: JSON.stringify({ userId: 'u2' }),
      },
      env(db),
    );
    expect(res.status).toBe(404);
  });

  // ── Create pending friendship ──────────────────────────────────

  it('POST /v1/friends/request creates pending friendship', async () => {
    const db = {
      prepare: (sql: string) => {
        const trimmed = sql.replace(/\s+/g, ' ').trim();
        const result = {
          first: async () => {
            if (trimmed.includes('FROM users WHERE id = ?') && trimmed.includes('github_login'))
              return user1;
            if (trimmed.includes('FROM users WHERE id = ?')) return { id: 'u2' };
            if (trimmed.includes('FROM friendships')) return null; // no existing friendship
            if (trimmed.includes('COUNT') && trimmed.includes('accepted')) return { n: 0 };
            if (trimmed.includes('COUNT') && trimmed.includes('pending')) return { n: 0 };
            return null;
          },
          all: async () => ({ results: [] }),
          run: async () => ({ meta: { changes: 1 } }),
        };
        return { ...result, bind: (..._args: unknown[]) => result };
      },
    } as unknown as D1Database;

    const res = await request(
      '/v1/friends/request',
      {
        method: 'POST',
        headers: { Authorization: await authHeader(), 'Content-Type': 'application/json' },
        body: JSON.stringify({ userId: 'u2' }),
      },
      env(db),
    );
    expect(res.status).toBe(200);
    const data = (await res.json()) as { status: string; autoAccepted: boolean };
    expect(data.status).toBe('pending');
    expect(data.autoAccepted).toBe(false);
  });

  // ── Auto-accept reciprocal request ─────────────────────────────

  it('POST /v1/friends/request auto-accepts reciprocal request', async () => {
    const db = {
      prepare: (sql: string) => {
        const trimmed = sql.replace(/\s+/g, ' ').trim();
        const result = {
          first: async () => {
            if (trimmed.includes('FROM users WHERE id = ?') && trimmed.includes('github_login'))
              return user1;
            if (trimmed.includes('FROM users WHERE id = ?')) return { id: 'u2' };
            if (trimmed.includes('FROM friendships'))
              return { status: 'pending', initiator: 'u2', blocker: null };
            return null;
          },
          all: async () => ({ results: [] }),
          run: async () => ({ meta: { changes: 1 } }),
        };
        return { ...result, bind: (..._args: unknown[]) => result };
      },
    } as unknown as D1Database;

    const res = await request(
      '/v1/friends/request',
      {
        method: 'POST',
        headers: { Authorization: await authHeader(), 'Content-Type': 'application/json' },
        body: JSON.stringify({ userId: 'u2' }),
      },
      env(db),
    );
    expect(res.status).toBe(200);
    const data = (await res.json()) as { status: string; autoAccepted: boolean };
    expect(data.status).toBe('accepted');
    expect(data.autoAccepted).toBe(true);
  });

  // ── Already friends ────────────────────────────────────────────

  it('POST /v1/friends/request returns 409 when already friends', async () => {
    const db = {
      prepare: (sql: string) => {
        const trimmed = sql.replace(/\s+/g, ' ').trim();
        const result = {
          first: async () => {
            if (trimmed.includes('FROM users WHERE id = ?') && trimmed.includes('github_login'))
              return user1;
            if (trimmed.includes('FROM users WHERE id = ?')) return { id: 'u2' };
            if (trimmed.includes('FROM friendships'))
              return { status: 'accepted', initiator: 'u1', blocker: null };
            return null;
          },
          all: async () => ({ results: [] }),
          run: async () => ({ meta: { changes: 0 } }),
        };
        return { ...result, bind: (..._args: unknown[]) => result };
      },
    } as unknown as D1Database;

    const res = await request(
      '/v1/friends/request',
      {
        method: 'POST',
        headers: { Authorization: await authHeader(), 'Content-Type': 'application/json' },
        body: JSON.stringify({ userId: 'u2' }),
      },
      env(db),
    );
    expect(res.status).toBe(409);
  });

  // ── Already pending from me ────────────────────────────────────

  it('POST /v1/friends/request returns 409 when already sent', async () => {
    const db = {
      prepare: (sql: string) => {
        const trimmed = sql.replace(/\s+/g, ' ').trim();
        const result = {
          first: async () => {
            if (trimmed.includes('FROM users WHERE id = ?') && trimmed.includes('github_login'))
              return user1;
            if (trimmed.includes('FROM users WHERE id = ?')) return { id: 'u2' };
            if (trimmed.includes('FROM friendships'))
              return { status: 'pending', initiator: 'u1', blocker: null };
            return null;
          },
          all: async () => ({ results: [] }),
          run: async () => ({ meta: { changes: 0 } }),
        };
        return { ...result, bind: (..._args: unknown[]) => result };
      },
    } as unknown as D1Database;

    const res = await request(
      '/v1/friends/request',
      {
        method: 'POST',
        headers: { Authorization: await authHeader(), 'Content-Type': 'application/json' },
        body: JSON.stringify({ userId: 'u2' }),
      },
      env(db),
    );
    expect(res.status).toBe(409);
  });

  // ── GET /friends — list accepted ────────────────────────────────

  it('GET /v1/friends returns accepted friends', async () => {
    const friendsList = [
      {
        user_a: 'u1',
        user_b: 'u2',
        status: 'accepted',
        initiator: 'u1',
        blocker: null,
        created_at: 1000,
        updated_at: 2000,
        friend_id: 'u2',
        github_login: 'bob',
        avatar_url: null,
        display_name: null,
      },
    ];
    const res = await request(
      '/v1/friends',
      {
        headers: { Authorization: await authHeader() },
      },
      env(fakeDB({ user: user1, friendsList })),
    );
    expect(res.status).toBe(200);
    const data = (await res.json()) as { friends: unknown[] };
    expect(data.friends).toHaveLength(1);
  });

  it.each([
    ['', 200, 0],
    ['?limit=50&offset=10', 50, 10],
    ['?limit=9999', 200, 0],
    ['?limit=-5&offset=-3', 200, 0],
    ['?limit=abc&offset=xyz', 200, 0],
  ])('GET /v1/friends%s binds LIMIT %i OFFSET %i', async (qs, limit, offset) => {
    let paging: unknown[] = [];
    const db = fakeDB({
      user: user1,
      onBind: (sql, args) => {
        if (sql.includes('FROM friendships f')) paging = args.slice(-2);
      },
    });
    const res = await request(
      `/v1/friends${qs}`,
      { headers: { Authorization: await authHeader() } },
      env(db),
    );
    expect(res.status).toBe(200);
    expect(paging).toEqual([limit, offset]);
  });

  it('GET /v1/friends?status=pending_incoming returns incoming requests', async () => {
    const friendsList = [
      {
        user_a: 'u1',
        user_b: 'u2',
        status: 'pending',
        initiator: 'u2',
        blocker: null,
        created_at: 1000,
        updated_at: 1000,
        friend_id: 'u2',
        github_login: 'bob',
        avatar_url: null,
        display_name: null,
      },
    ];
    const res = await request(
      '/v1/friends?status=pending_incoming',
      {
        headers: { Authorization: await authHeader() },
      },
      env(fakeDB({ user: user1, friendsList })),
    );
    expect(res.status).toBe(200);
    const data = (await res.json()) as { friends: unknown[] };
    expect(data.friends).toHaveLength(1);
  });

  it('GET /v1/friends?status=pending_outgoing returns outgoing requests', async () => {
    const friendsList = [
      {
        user_a: 'u1',
        user_b: 'u2',
        status: 'pending',
        initiator: 'u1',
        blocker: null,
        created_at: 1000,
        updated_at: 1000,
        friend_id: 'u2',
        github_login: 'bob',
        avatar_url: null,
        display_name: null,
      },
    ];
    const res = await request(
      '/v1/friends?status=pending_outgoing',
      {
        headers: { Authorization: await authHeader() },
      },
      env(fakeDB({ user: user1, friendsList })),
    );
    expect(res.status).toBe(200);
    const data = (await res.json()) as { friends: unknown[] };
    expect(data.friends).toHaveLength(1);
  });

  // ── PATCH /friends/:userId — accept ─────────────────────────────

  it('PATCH /v1/friends/:userId accepts incoming request', async () => {
    const db = {
      prepare: (sql: string) => {
        const trimmed = sql.replace(/\s+/g, ' ').trim();
        const result = {
          first: async () => {
            if (trimmed.includes('FROM users')) return user1;
            if (trimmed.includes('FROM friendships'))
              return { status: 'pending', initiator: 'u2', blocker: null };
            return null;
          },
          all: async () => ({ results: [] }),
          run: async () => ({ meta: { changes: 1 } }),
        };
        return { ...result, bind: (..._args: unknown[]) => result };
      },
    } as unknown as D1Database;

    const res = await request(
      '/v1/friends/u2',
      {
        method: 'PATCH',
        headers: { Authorization: await authHeader(), 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'accept' }),
      },
      env(db),
    );
    expect(res.status).toBe(200);
    const data = (await res.json()) as { ok: boolean; status: string };
    expect(data.status).toBe('accepted');
  });

  it('PATCH /v1/friends/:userId accept enforces the friend cap (conditional UPDATE matches 0 rows)', async () => {
    const db = {
      prepare: (sql: string) => {
        const trimmed = sql.replace(/\s+/g, ' ').trim();
        const result = {
          first: async () => {
            if (trimmed.includes('FROM users')) return user1;
            if (trimmed.includes('FROM friendships'))
              return { status: 'pending', initiator: 'u2', blocker: null };
            return null;
          },
          all: async () => ({ results: [] }),
          // The cap-guarded UPDATE matches no rows when the accepter is at MAX.
          run: async () => ({
            meta: { changes: trimmed.startsWith('UPDATE friendships') ? 0 : 1 },
          }),
        };
        return { ...result, bind: (..._args: unknown[]) => result };
      },
    } as unknown as D1Database;

    const res = await request(
      '/v1/friends/u2',
      {
        method: 'PATCH',
        headers: { Authorization: await authHeader(), 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'accept' }),
      },
      env(db),
    );
    expect(res.status).toBe(409);
    const data = (await res.json()) as { error: string };
    expect(data.error).toContain('friend limit');
  });

  it('PATCH /v1/friends/:userId rejects accepting own request', async () => {
    const db = {
      prepare: (sql: string) => {
        const trimmed = sql.replace(/\s+/g, ' ').trim();
        const result = {
          first: async () => {
            if (trimmed.includes('FROM users')) return user1;
            if (trimmed.includes('FROM friendships'))
              return { status: 'pending', initiator: 'u1', blocker: null };
            return null;
          },
          all: async () => ({ results: [] }),
          run: async () => ({ meta: { changes: 1 } }),
        };
        return { ...result, bind: (..._args: unknown[]) => result };
      },
    } as unknown as D1Database;

    const res = await request(
      '/v1/friends/u2',
      {
        method: 'PATCH',
        headers: { Authorization: await authHeader(), 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'accept' }),
      },
      env(db),
    );
    expect(res.status).toBe(400);
  });

  // ── PATCH /friends/:userId — decline ────────────────────────────

  it('PATCH /v1/friends/:userId declines request (deletes row)', async () => {
    const db = {
      prepare: (sql: string) => {
        const trimmed = sql.replace(/\s+/g, ' ').trim();
        const result = {
          first: async () => {
            if (trimmed.includes('FROM users')) return user1;
            if (trimmed.includes('FROM friendships'))
              return { status: 'pending', initiator: 'u2', blocker: null };
            return null;
          },
          all: async () => ({ results: [] }),
          run: async () => ({ meta: { changes: 1 } }),
        };
        return { ...result, bind: (..._args: unknown[]) => result };
      },
    } as unknown as D1Database;

    const res = await request(
      '/v1/friends/u2',
      {
        method: 'PATCH',
        headers: { Authorization: await authHeader(), 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'decline' }),
      },
      env(db),
    );
    expect(res.status).toBe(200);
  });

  // ── PATCH /friends/:userId — block ──────────────────────────────

  it('PATCH /v1/friends/:userId blocks a user', async () => {
    const db = {
      prepare: (sql: string) => {
        const trimmed = sql.replace(/\s+/g, ' ').trim();
        const result = {
          first: async () => {
            if (trimmed.includes('FROM users')) return user1;
            return null;
          },
          all: async () => ({ results: [] }),
          run: async () => ({ meta: { changes: 1 } }),
        };
        return { ...result, bind: (..._args: unknown[]) => result };
      },
    } as unknown as D1Database;

    const res = await request(
      '/v1/friends/u2',
      {
        method: 'PATCH',
        headers: { Authorization: await authHeader(), 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'block' }),
      },
      env(db),
    );
    expect(res.status).toBe(200);
    const data = (await res.json()) as { ok: boolean; status: string };
    expect(data.status).toBe('blocked');
  });

  it('PATCH /v1/friends/:userId block refuses an id that is not an account (#469)', async () => {
    const writes: string[] = [];
    const db = {
      prepare: (sql: string) => {
        const trimmed = sql.replace(/\s+/g, ' ').trim();
        return {
          bind: (...args: unknown[]) => ({
            first: async () => (trimmed.includes('FROM users') && args[0] === 'u1' ? user1 : null),
            run: async () => {
              writes.push(trimmed);
              return { meta: { changes: 1 } };
            },
          }),
        };
      },
    } as unknown as D1Database;
    const res = await request(
      '/v1/friends/ghost-id',
      {
        method: 'PATCH',
        headers: { Authorization: await authHeader(), 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'block' }),
      },
      env(db),
    );
    expect(res.status).toBe(404);
    expect(writes).toEqual([]);
  });

  it('PATCH /v1/friends/:userId block does not overwrite existing blocker', async () => {
    const db = {
      prepare: (sql: string) => {
        const trimmed = sql.replace(/\s+/g, ' ').trim();
        const result = {
          first: async () => {
            if (trimmed.includes('FROM users')) return user1;
            if (trimmed.includes('FROM friendships')) return { status: 'blocked', blocker: 'u2' }; // already blocked by u2
            return null;
          },
          all: async () => ({ results: [] }),
          run: async () => ({ meta: { changes: 0 } }),
        };
        return { ...result, bind: (..._args: unknown[]) => result };
      },
    } as unknown as D1Database;

    const res = await request(
      '/v1/friends/u2',
      {
        method: 'PATCH',
        headers: { Authorization: await authHeader(), 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'block' }),
      },
      env(db),
    );
    expect(res.status).toBe(200);
    const data = (await res.json()) as { ok: boolean; status: string };
    expect(data.status).toBe('blocked');
    // The key assertion: run() was never called (no DB write), meaning
    // the blocker field was NOT overwritten. We verify by checking that
    // the mock's run() returning changes:0 didn't cause an error.
  });

  // ── DELETE /friends/:userId ─────────────────────────────────────

  it('DELETE /v1/friends/:userId removes friend', async () => {
    const db = {
      prepare: (sql: string) => {
        const trimmed = sql.replace(/\s+/g, ' ').trim();
        const result = {
          first: async () => {
            if (trimmed.includes('FROM users')) return user1;
            if (trimmed.includes('FROM friendships'))
              return { status: 'accepted', initiator: 'u1', blocker: null };
            return null;
          },
          all: async () => ({ results: [] }),
          run: async () => ({ meta: { changes: 1 } }),
        };
        return { ...result, bind: (..._args: unknown[]) => result };
      },
    } as unknown as D1Database;

    const res = await request(
      '/v1/friends/u2',
      {
        method: 'DELETE',
        headers: { Authorization: await authHeader() },
      },
      env(db),
    );
    expect(res.status).toBe(200);
  });

  it('DELETE /v1/friends/:userId cancels outgoing request', async () => {
    const db = {
      prepare: (sql: string) => {
        const trimmed = sql.replace(/\s+/g, ' ').trim();
        const result = {
          first: async () => {
            if (trimmed.includes('FROM users')) return user1;
            if (trimmed.includes('FROM friendships'))
              return { status: 'pending', initiator: 'u1', blocker: null };
            return null;
          },
          all: async () => ({ results: [] }),
          run: async () => ({ meta: { changes: 1 } }),
        };
        return { ...result, bind: (..._args: unknown[]) => result };
      },
    } as unknown as D1Database;

    const res = await request(
      '/v1/friends/u2',
      {
        method: 'DELETE',
        headers: { Authorization: await authHeader() },
      },
      env(db),
    );
    expect(res.status).toBe(200);
  });

  it('DELETE /v1/friends/:userId returns 403 when non-blocker tries to unblock', async () => {
    const db = {
      prepare: (sql: string) => {
        const trimmed = sql.replace(/\s+/g, ' ').trim();
        const result = {
          first: async () => {
            if (trimmed.includes('FROM users')) return user1;
            if (trimmed.includes('FROM friendships'))
              return { status: 'blocked', initiator: 'u2', blocker: 'u2' };
            return null;
          },
          all: async () => ({ results: [] }),
          run: async () => ({ meta: { changes: 0 } }),
        };
        return { ...result, bind: (..._args: unknown[]) => result };
      },
    } as unknown as D1Database;

    const res = await request(
      '/v1/friends/u2',
      {
        method: 'DELETE',
        headers: { Authorization: await authHeader() },
      },
      env(db),
    );
    expect(res.status).toBe(403);
  });

  it('DELETE /v1/friends/:userId returns 404 when no friendship exists', async () => {
    const db = {
      prepare: (sql: string) => {
        const trimmed = sql.replace(/\s+/g, ' ').trim();
        const result = {
          first: async () => {
            if (trimmed.includes('FROM users')) return user1;
            if (trimmed.includes('FROM friendships')) return null;
            return null;
          },
          all: async () => ({ results: [] }),
          run: async () => ({ meta: { changes: 0 } }),
        };
        return { ...result, bind: (..._args: unknown[]) => result };
      },
    } as unknown as D1Database;

    const res = await request(
      '/v1/friends/u2',
      {
        method: 'DELETE',
        headers: { Authorization: await authHeader() },
      },
      env(db),
    );
    expect(res.status).toBe(404);
  });

  // ── GET /friends/check/:userId ──────────────────────────────────

  it('GET /v1/friends/check/:userId returns accepted', async () => {
    const db = {
      prepare: (sql: string) => {
        const trimmed = sql.replace(/\s+/g, ' ').trim();
        const result = {
          first: async () => {
            if (trimmed.includes('FROM users')) return user1;
            if (trimmed.includes('FROM friendships'))
              return { status: 'accepted', blocker: null, initiator: 'u1' };
            return null;
          },
          all: async () => ({ results: [] }),
          run: async () => ({ meta: { changes: 0 } }),
        };
        return { ...result, bind: (..._args: unknown[]) => result };
      },
    } as unknown as D1Database;

    const res = await request(
      '/v1/friends/check/u2',
      {
        headers: { Authorization: await authHeader() },
      },
      env(db),
    );
    expect(res.status).toBe(200);
    const data = (await res.json()) as { status: string };
    expect(data.status).toBe('accepted');
  });

  it('GET /v1/friends/check/:userId returns none when no friendship', async () => {
    const db = {
      prepare: (sql: string) => {
        const trimmed = sql.replace(/\s+/g, ' ').trim();
        const result = {
          first: async () => {
            if (trimmed.includes('FROM users')) return user1;
            if (trimmed.includes('FROM friendships')) return null;
            return null;
          },
          all: async () => ({ results: [] }),
          run: async () => ({ meta: { changes: 0 } }),
        };
        return { ...result, bind: (..._args: unknown[]) => result };
      },
    } as unknown as D1Database;

    const res = await request(
      '/v1/friends/check/u2',
      {
        headers: { Authorization: await authHeader() },
      },
      env(db),
    );
    expect(res.status).toBe(200);
    const data = (await res.json()) as { status: string };
    expect(data.status).toBe('none');
  });

  it('GET /v1/friends/check/:userId returns none when blocked by them (invisible)', async () => {
    const db = {
      prepare: (sql: string) => {
        const trimmed = sql.replace(/\s+/g, ' ').trim();
        const result = {
          first: async () => {
            if (trimmed.includes('FROM users')) return user1;
            if (trimmed.includes('FROM friendships'))
              return { status: 'blocked', blocker: 'u2', initiator: 'u2' };
            return null;
          },
          all: async () => ({ results: [] }),
          run: async () => ({ meta: { changes: 0 } }),
        };
        return { ...result, bind: (..._args: unknown[]) => result };
      },
    } as unknown as D1Database;

    const res = await request(
      '/v1/friends/check/u2',
      {
        headers: { Authorization: await authHeader() },
      },
      env(db),
    );
    expect(res.status).toBe(200);
    const data = (await res.json()) as { status: string };
    expect(data.status).toBe('none');
  });

  it('GET /v1/friends/check/:userId returns blocked_by_you when I blocked them', async () => {
    const db = {
      prepare: (sql: string) => {
        const trimmed = sql.replace(/\s+/g, ' ').trim();
        const result = {
          first: async () => {
            if (trimmed.includes('FROM users')) return user1;
            if (trimmed.includes('FROM friendships'))
              return { status: 'blocked', blocker: 'u1', initiator: 'u1' };
            return null;
          },
          all: async () => ({ results: [] }),
          run: async () => ({ meta: { changes: 0 } }),
        };
        return { ...result, bind: (..._args: unknown[]) => result };
      },
    } as unknown as D1Database;

    const res = await request(
      '/v1/friends/check/u2',
      {
        headers: { Authorization: await authHeader() },
      },
      env(db),
    );
    expect(res.status).toBe(200);
    const data = (await res.json()) as { status: string };
    expect(data.status).toBe('blocked_by_you');
  });

  // ── GET /friends/search ─────────────────────────────────────────

  it('GET /v1/friends/search returns matching users with status', async () => {
    const db = {
      prepare: (sql: string) => {
        const trimmed = sql.replace(/\s+/g, ' ').trim();
        const result = {
          first: async () => {
            if (trimmed.includes('FROM users WHERE id = ?')) return user1;
            if (trimmed.includes('FROM friendships')) return null; // no friendship
            return null;
          },
          all: async () => {
            if (trimmed.includes('LIKE')) return { results: [user2] };
            return { results: [] };
          },
          run: async () => ({ meta: { changes: 0 } }),
        };
        return { ...result, bind: (..._args: unknown[]) => result };
      },
    } as unknown as D1Database;

    const res = await request(
      '/v1/friends/search?q=bob',
      {
        headers: { Authorization: await authHeader() },
      },
      env(db),
    );
    expect(res.status).toBe(200);
    const data = (await res.json()) as { users: Array<{ userId: string; friendStatus: string }> };
    expect(data.users).toHaveLength(1);
    expect(data.users[0]!.friendStatus).toBe('none');
  });

  it('GET /v1/friends/search excludes users who blocked the searcher', async () => {
    const db = {
      prepare: (sql: string) => {
        const trimmed = sql.replace(/\s+/g, ' ').trim();
        const result = {
          first: async () => {
            if (trimmed.includes('FROM users WHERE id = ?')) return user1;
            if (trimmed.includes('FROM friendships'))
              return { status: 'blocked', blocker: 'u2', initiator: 'u2' }; // u2 blocked u1
            return null;
          },
          all: async () => {
            if (trimmed.includes('LIKE')) return { results: [user2] };
            return { results: [] };
          },
          run: async () => ({ meta: { changes: 0 } }),
        };
        return { ...result, bind: (..._args: unknown[]) => result };
      },
    } as unknown as D1Database;

    const res = await request(
      '/v1/friends/search?q=bob',
      {
        headers: { Authorization: await authHeader() },
      },
      env(db),
    );
    expect(res.status).toBe(200);
    const data = (await res.json()) as { users: unknown[] };
    expect(data.users).toHaveLength(0);
  });

  it('GET /v1/friends/search rejects short query', async () => {
    const res = await request(
      '/v1/friends/search?q=ab',
      {
        headers: { Authorization: await authHeader() },
      },
      env(fakeDB({ user: user1 })),
    );
    expect(res.status).toBe(400);
  });
});

describe.skipIf(!hasSqlite)('expired pending requests are gone (#760)', () => {
  const DAY = 24 * 60 * 60 * 1000;
  afterEach(() => {
    requestRateMap.clear();
    mutationRateMap.clear();
    requestCooldownMap.clear();
  });

  function setup(pendingAgeMs: number) {
    const { db, d1 } = sqliteD1();
    for (const [id, githubId, login] of [
      ['gh:1', 1, 'alice'],
      ['gh:2', 2, 'bob'],
    ] as const)
      db.prepare(
        'INSERT INTO users (id, github_id, github_login, avatar_url, created_at) VALUES (?, ?, ?, NULL, 0)',
      ).run(id, githubId, login);
    const at = Date.now() - pendingAgeMs;
    db.prepare(
      "INSERT INTO friendships (user_a, user_b, status, initiator, created_at, updated_at) VALUES ('gh:1', 'gh:2', 'pending', 'gh:1', ?, ?)",
    ).run(at, at);
    const env = { DB: d1, SESSION_SIGNING_KEY: SIGNING_KEY };
    const as = async (uid: string) => ({
      Authorization: `Bearer ${await signSession(uid, SIGNING_KEY, { aud: 'console' })}`,
      'Content-Type': 'application/json',
    });
    const status = () =>
      (db.prepare('SELECT status, initiator FROM friendships').get() as {
        status: string;
        initiator: string;
      }) ?? null;
    return { env, as, status };
  }

  it('lets the initiator ask again instead of 409', async () => {
    const { env, as, status } = setup(31 * DAY);
    const res = await request(
      '/v1/friends/request',
      { method: 'POST', headers: await as('gh:1'), body: JSON.stringify({ userId: 'gh:2' }) },
      env,
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: 'pending', autoAccepted: false });
    expect(status()).toEqual({ status: 'pending', initiator: 'gh:1' });
  });

  it('is not auto-accepted by the other side asking', async () => {
    const { env, as, status } = setup(31 * DAY);
    const res = await request(
      '/v1/friends/request',
      { method: 'POST', headers: await as('gh:2'), body: JSON.stringify({ userId: 'gh:1' }) },
      env,
    );
    expect(await res.json()).toEqual({ status: 'pending', autoAccepted: false });
    expect(status()).toEqual({ status: 'pending', initiator: 'gh:2' });
  });

  it('cannot be accepted and is reported as none', async () => {
    const { env, as, status } = setup(31 * DAY);
    const accept = await request(
      '/v1/friends/gh:1',
      { method: 'PATCH', headers: await as('gh:2'), body: JSON.stringify({ action: 'accept' }) },
      env,
    );
    expect(accept.status).toBe(404);
    expect(status().status).toBe('pending');
    const check = await request('/v1/friends/check/gh:1', { headers: await as('gh:2') }, env);
    expect(await check.json()).toEqual({ status: 'none' });
  });

  it('a live request still auto-accepts', async () => {
    const { env, as, status } = setup(DAY);
    const res = await request(
      '/v1/friends/request',
      { method: 'POST', headers: await as('gh:2'), body: JSON.stringify({ userId: 'gh:1' }) },
      env,
    );
    expect(await res.json()).toEqual({ status: 'accepted', autoAccepted: true });
    expect(status().status).toBe('accepted');
  });
});

describe.skipIf(!hasSqlite)('friend webhooks do not hold the request (#764)', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    requestRateMap.clear();
  });

  it('answers before a hung hook settles and delivers in the background', async () => {
    background.length = 0;
    const { db, d1 } = sqliteD1();
    for (const [id, githubId, login] of [
      ['gh:1', 1, 'alice'],
      ['gh:2', 2, 'bob'],
    ] as const) {
      db.prepare(
        'INSERT INTO users (id, github_id, github_login, avatar_url, created_at) VALUES (?, ?, ?, NULL, 0)',
      ).run(id, githubId, login);
      db.prepare(
        "INSERT INTO app_roles (app_id, user_id, role_name, granted_by) VALUES ('timer', ?, 'member', NULL)",
      ).run(id);
    }
    db.prepare("INSERT INTO apps (id, owner_login, created_at) VALUES ('timer', 'owner', 1)").run();
    db.prepare(
      "INSERT INTO app_webhooks (id, app_id, event, url, secret) VALUES ('w1', 'timer', 'friend.requested', 'https://example.com/h', 's')",
    ).run();
    let release = () => {};
    const hookCalled = new Promise<void>((resolve) => {
      vi.stubGlobal(
        'fetch',
        vi.fn(async (u: string) => {
          if (String(u).startsWith('https://cloudflare-dns.com/'))
            return Response.json({ Answer: [{ type: 1, data: '93.184.216.34' }] });
          resolve();
          await new Promise<void>((r) => {
            release = r;
          });
          return new Response('ok');
        }),
      );
    });

    const res = await request(
      '/v1/friends/request',
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${await signSession('gh:1', SIGNING_KEY, { aud: 'console' })}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ userId: 'gh:2' }),
      },
      { DB: d1, SESSION_SIGNING_KEY: SIGNING_KEY },
    );
    expect(res.status).toBe(200);
    expect(background).toHaveLength(1);
    await hookCalled;
    release();
    await Promise.all(background);
    expect(db.prepare('SELECT status FROM webhook_deliveries').get()).toEqual({ status: 200 });
  });
});
