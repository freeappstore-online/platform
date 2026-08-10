import { describe, expect, it } from 'vitest';
import { app } from '../index.js';
import { signSession } from '../lib/session.js';

const SIGNING_KEY = 'a'.repeat(64);

function fakeDB(opts: {
  user?: Record<string, unknown> | null;
  appExists?: boolean;
  existingVote?: boolean;
  voteCount?: number;
  recentVoteCount?: number;
}) {
  return {
    prepare: (sql: string) => {
      const trimmed = sql.replace(/\s+/g, ' ').trim();
      const result = {
        first: async () => {
          if (trimmed.includes('FROM users')) return opts.user ?? null;
          if (trimmed.includes('FROM apps')) return opts.appExists !== false ? { 1: 1 } : null;
          if (
            trimmed.includes('FROM app_votes WHERE user_id') &&
            trimmed.includes('created_at >')
          ) {
            return { cnt: opts.recentVoteCount ?? 0 };
          }
          if (trimmed.includes('FROM app_votes WHERE app_id') && trimmed.includes('user_id')) {
            return opts.existingVote ? { 1: 1 } : null;
          }
          if (trimmed.includes('COUNT(*)') && trimmed.includes('FROM app_votes WHERE app_id')) {
            return { cnt: opts.voteCount ?? 0 };
          }
          return null;
        },
        all: async () => {
          if (trimmed.includes('FROM app_votes GROUP BY app_id')) {
            return { results: opts.voteCount ? [{ app_id: 'timer', count: opts.voteCount }] : [] };
          }
          return { results: [] };
        },
        run: async () => ({ meta: { changes: 1 } }),
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

describe('vote routes', () => {
  const user = { id: 'u1', github_login: 'testuser', avatar_url: null, date_of_birth: null };

  // GET /v1/store/votes — public aggregate
  it('GET /v1/store/votes returns empty votes with no auth', async () => {
    const res = await app.request('/v1/store/votes', {}, env(fakeDB({})));
    expect(res.status).toBe(200);
    const data = (await res.json()) as { votes: Record<string, number> };
    expect(typeof data.votes).toBe('object');
  });

  it('GET /v1/store/votes returns vote counts', async () => {
    const res = await app.request('/v1/store/votes', {}, env(fakeDB({ voteCount: 5 })));
    expect(res.status).toBe(200);
    const data = (await res.json()) as { votes: Record<string, number> };
    expect(data.votes['timer']).toBe(5);
  });

  it('GET /v1/store/votes sets Cache-Control header', async () => {
    const res = await app.request('/v1/store/votes', {}, env(fakeDB({})));
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toContain('max-age=60');
  });

  // POST /v1/store/apps/:appId/vote — auth required
  it('POST /v1/store/apps/:appId/vote requires auth', async () => {
    const res = await app.request('/v1/store/apps/timer/vote', { method: 'POST' }, env(fakeDB({})));
    expect(res.status).toBe(401);
  });

  it('POST /v1/store/apps/:appId/vote returns 404 for unknown app', async () => {
    const res = await app.request(
      '/v1/store/apps/nonexistent/vote',
      {
        method: 'POST',
        headers: { Authorization: await authHeader() },
      },
      env(fakeDB({ user, appExists: false })),
    );
    expect(res.status).toBe(404);
  });

  it('POST /v1/store/apps/:appId/vote records a vote', async () => {
    const res = await app.request(
      '/v1/store/apps/timer/vote',
      {
        method: 'POST',
        headers: { Authorization: await authHeader() },
      },
      env(fakeDB({ user, voteCount: 1 })),
    );
    expect(res.status).toBe(200);
    const data = (await res.json()) as { voted: boolean; count: number };
    expect(data.voted).toBe(true);
    expect(typeof data.count).toBe('number');
  });

  it('POST /v1/store/apps/:appId/vote is idempotent (existing vote not rate-limited)', async () => {
    // existingVote=true means the user already voted — re-voting should succeed
    // even though recentVoteCount=10 would normally rate-limit a new vote.
    const res = await app.request(
      '/v1/store/apps/timer/vote',
      {
        method: 'POST',
        headers: { Authorization: await authHeader() },
      },
      env(fakeDB({ user, existingVote: true, recentVoteCount: 10, voteCount: 3 })),
    );
    expect(res.status).toBe(200);
    const data = (await res.json()) as { voted: boolean; count: number };
    expect(data.voted).toBe(true);
  });

  it('POST /v1/store/apps/:appId/vote enforces rate limit', async () => {
    const res = await app.request(
      '/v1/store/apps/timer/vote',
      {
        method: 'POST',
        headers: { Authorization: await authHeader() },
      },
      // existingVote=false so the rate limit check runs; recentVoteCount >= 10 triggers 429
      env(fakeDB({ user, existingVote: false, recentVoteCount: 10 })),
    );
    expect(res.status).toBe(429);
  });

  // DELETE /v1/store/apps/:appId/vote — auth required
  it('DELETE /v1/store/apps/:appId/vote requires auth', async () => {
    const res = await app.request(
      '/v1/store/apps/timer/vote',
      { method: 'DELETE' },
      env(fakeDB({})),
    );
    expect(res.status).toBe(401);
  });

  it('DELETE /v1/store/apps/:appId/vote returns 404 for unknown app', async () => {
    const res = await app.request(
      '/v1/store/apps/nonexistent/vote',
      {
        method: 'DELETE',
        headers: { Authorization: await authHeader() },
      },
      env(fakeDB({ user, appExists: false })),
    );
    expect(res.status).toBe(404);
  });

  it('DELETE /v1/store/apps/:appId/vote removes a vote', async () => {
    const res = await app.request(
      '/v1/store/apps/timer/vote',
      {
        method: 'DELETE',
        headers: { Authorization: await authHeader() },
      },
      env(fakeDB({ user, voteCount: 0 })),
    );
    expect(res.status).toBe(200);
    const data = (await res.json()) as { voted: boolean; count: number };
    expect(data.voted).toBe(false);
    expect(typeof data.count).toBe('number');
  });

  it('DELETE /v1/store/apps/:appId/vote is idempotent (no vote to delete returns 200)', async () => {
    const res = await app.request(
      '/v1/store/apps/timer/vote',
      {
        method: 'DELETE',
        headers: { Authorization: await authHeader() },
      },
      env(fakeDB({ user, voteCount: 0 })),
    );
    expect(res.status).toBe(200);
    const data = (await res.json()) as { voted: boolean; count: number };
    expect(data.voted).toBe(false);
  });
});
