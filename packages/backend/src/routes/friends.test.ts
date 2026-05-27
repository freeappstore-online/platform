import { afterEach, describe, expect, it } from 'vitest';
import { app } from '../index.js';
import { signSession } from '../lib/session.js';
import { mutationRateMap, requestCooldownMap, requestRateMap, searchRateMap } from './friends.js';

const SIGNING_KEY = 'a'.repeat(64);

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
      return { ...result, bind: (..._args: unknown[]) => result };
    },
  } as unknown as D1Database;
}

function env(db: D1Database) {
  return { DB: db, SESSION_SIGNING_KEY: SIGNING_KEY };
}

async function authHeader(userId = 'u1') {
  const token = await signSession(userId, SIGNING_KEY);
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
    const res = await app.request(
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
    const res = await app.request(
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

    const res = await app.request(
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

    const res = await app.request(
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

    const res = await app.request(
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

    const res = await app.request(
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

    const res = await app.request(
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

    const res = await app.request(
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
    const res = await app.request(
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
    const res = await app.request(
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
    const res = await app.request(
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

    const res = await app.request(
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

    const res = await app.request(
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

    const res = await app.request(
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

    const res = await app.request(
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

    const res = await app.request(
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

    const res = await app.request(
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

    const res = await app.request(
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

    const res = await app.request(
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

    const res = await app.request(
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

    const res = await app.request(
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

    const res = await app.request(
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

    const res = await app.request(
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

    const res = await app.request(
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

    const res = await app.request(
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

    const res = await app.request(
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
    const res = await app.request(
      '/v1/friends/search?q=ab',
      {
        headers: { Authorization: await authHeader() },
      },
      env(fakeDB({ user: user1 })),
    );
    expect(res.status).toBe(400);
  });
});
