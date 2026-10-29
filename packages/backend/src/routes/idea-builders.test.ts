import { describe, expect, it } from 'vitest';
import { app } from '../index.js';
import { signSession } from '../lib/session.js';

const SIGNING_KEY = 'a'.repeat(64);
const user = { id: 'u1', github_login: 'testuser', avatar_url: null, date_of_birth: null };

function fakeDB(opts: {
  existing?: { created_at: number } | null;
  active?: number;
  recent?: number;
  count?: number;
  mine?: string[];
  calls?: { sql: string; args: unknown[] }[];
}) {
  return {
    prepare: (sql: string) => {
      const q = sql.replace(/\s+/g, ' ').trim();
      let args: unknown[] = [];
      const result = {
        first: async () => {
          if (q.includes('FROM users')) return user;
          if (q.startsWith('SELECT created_at FROM idea_builders')) return opts.existing ?? null;
          if (q.includes('SUM(created_at'))
            return { active: opts.active ?? 0, recent: opts.recent ?? 0 };
          if (q.includes('COUNT(*) AS cnt FROM idea_builders')) return { cnt: opts.count ?? 0 };
          return null;
        },
        all: async () => {
          if (q.includes('GROUP BY idea_id')) {
            return { results: opts.count ? [{ idea_id: 'habit-tracker', count: opts.count }] : [] };
          }
          if (q.startsWith('SELECT idea_id FROM idea_builders WHERE user_id')) {
            return { results: (opts.mine ?? []).map((idea_id) => ({ idea_id })) };
          }
          return { results: [] };
        },
        run: async () => {
          opts.calls?.push({ sql: q, args });
          return { meta: { changes: 1 } };
        },
      };
      return {
        ...result,
        bind: (...a: unknown[]) => {
          args = a;
          return result;
        },
      };
    },
  } as unknown as D1Database;
}

const env = (db: D1Database) => ({ DB: db, SESSION_SIGNING_KEY: SIGNING_KEY });
const auth = async () => ({ Authorization: `Bearer ${await signSession('u1', SIGNING_KEY)}` });

describe('idea builder claims', () => {
  it('GET is public, aggregate-only and cacheable without auth', async () => {
    const res = await app.request(
      '/v1/store/idea-builders',
      {},
      env(fakeDB({ count: 2, mine: ['x'] })),
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ builders: { 'habit-tracker': 2 } });
    expect(res.headers.get('cache-control')).toContain('public');
  });

  it('GET with auth adds only the caller’s claims and is not cached publicly', async () => {
    const res = await app.request(
      '/v1/store/idea-builders',
      { headers: await auth() },
      env(fakeDB({ count: 2, mine: ['habit-tracker'] })),
    );
    expect(await res.json()).toEqual({
      builders: { 'habit-tracker': 2 },
      mine: { 'habit-tracker': true },
    });
    expect(res.headers.get('cache-control')).toBe('private, no-store');
    expect(res.headers.get('vary')).toContain('Authorization');
  });

  it('GET with a bad token is 401, not silently anonymous', async () => {
    const res = await app.request(
      '/v1/store/idea-builders',
      { headers: { Authorization: 'Bearer nope' } },
      env(fakeDB({})),
    );
    expect(res.status).toBe(401);
  });

  it('POST and DELETE require auth', async () => {
    for (const method of ['POST', 'DELETE']) {
      const res = await app.request(
        '/v1/store/ideas/habit-tracker/builder',
        { method },
        env(fakeDB({})),
      );
      expect(res.status).toBe(401);
    }
  });

  it('rejects malformed idea ids', async () => {
    const res = await app.request(
      '/v1/store/ideas/Bad_Id/builder',
      { method: 'POST', headers: await auth() },
      env(fakeDB({})),
    );
    expect(res.status).toBe(400);
  });

  it('POST claims an idea and returns the active count', async () => {
    const calls: { sql: string; args: unknown[] }[] = [];
    const res = await app.request(
      '/v1/store/ideas/habit-tracker/builder',
      { method: 'POST', headers: await auth() },
      env(fakeDB({ count: 3, calls })),
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ building: true, count: 3 });
    expect(calls[0]?.sql).toContain('ON CONFLICT(idea_id, user_id) DO UPDATE');
    expect(calls[0]?.args.slice(0, 2)).toEqual(['habit-tracker', 'u1']);
  });

  it('caps active claims per user, but re-claiming an active one is fine', async () => {
    const full = env(fakeDB({ active: 10 }));
    const res = await app.request(
      '/v1/store/ideas/new-one/builder',
      { method: 'POST', headers: await auth() },
      full,
    );
    expect(res.status).toBe(409);
    const again = await app.request(
      '/v1/store/ideas/habit-tracker/builder',
      { method: 'POST', headers: await auth() },
      env(fakeDB({ active: 10, existing: { created_at: Math.floor(Date.now() / 1000) } })),
    );
    expect(again.status).toBe(200);
  });

  it('a stale claim counts as new against the limits', async () => {
    const res = await app.request(
      '/v1/store/ideas/habit-tracker/builder',
      { method: 'POST', headers: await auth() },
      env(fakeDB({ active: 10, existing: { created_at: 1 } })),
    );
    expect(res.status).toBe(409);
  });

  it('rate-limits bursts of new claims', async () => {
    const res = await app.request(
      '/v1/store/ideas/habit-tracker/builder',
      { method: 'POST', headers: await auth() },
      env(fakeDB({ recent: 10 })),
    );
    expect(res.status).toBe(429);
  });

  it('DELETE drops the claim', async () => {
    const calls: { sql: string; args: unknown[] }[] = [];
    const res = await app.request(
      '/v1/store/ideas/habit-tracker/builder',
      { method: 'DELETE', headers: await auth() },
      env(fakeDB({ count: 1, calls })),
    );
    expect(await res.json()).toEqual({ building: false, count: 1 });
    expect(calls[0]?.sql).toContain('DELETE FROM idea_builders');
  });
});
