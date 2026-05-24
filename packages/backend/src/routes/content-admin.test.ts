import { describe, expect, it } from 'vitest';
import { app } from '../index.js';
import { signSession } from '../lib/session.js';

const SIGNING_KEY = 'a'.repeat(64);

function fakeDB(opts: {
  user?: Record<string, unknown> | null;
  kvEntries?: Array<Record<string, unknown>>;
  docs?: Array<Record<string, unknown>>;
  counters?: Array<Record<string, unknown>>;
  users?: Array<Record<string, unknown>>;
  apps?: Array<Record<string, unknown>>;
  stats?: Record<string, number>;
  kvValue?: Record<string, unknown> | null;
}) {
  return {
    prepare: (sql: string) => {
      const trimmed = sql.replace(/\s+/g, ' ').trim();
      const stmtResult = {
        first: async () => {
          if (trimmed.includes('FROM users')) return opts.user ?? null;
          if (trimmed.includes('FROM kv') && trimmed.includes('value FROM')) return opts.kvValue ?? null;
          if (trimmed.includes('COUNT(*)')) return { n: opts.stats?.users ?? 0 };
          return null;
        },
        all: async () => {
          if (trimmed.includes('FROM kv')) return { results: opts.kvEntries ?? [] };
          if (trimmed.includes('FROM documents')) return { results: opts.docs ?? [] };
          if (trimmed.includes('FROM counters')) return { results: opts.counters ?? [] };
          if (trimmed.includes('FROM users') && trimmed.includes('LIMIT')) return { results: opts.users ?? [] };
          if (trimmed.includes('FROM apps')) return { results: opts.apps ?? [] };
          return { results: [] };
        },
        run: async () => ({ meta: { changes: 1 } }),
      };
      return {
        ...stmtResult,
        bind: (..._args: unknown[]) => stmtResult,
      };
    },
  } as unknown as D1Database;
}

function env(db: D1Database) {
  return { DB: db, SESSION_SIGNING_KEY: SIGNING_KEY };
}

async function adminHeader() {
  const token = await signSession('admin-1', SIGNING_KEY, { roles: ['admin'] });
  return `Bearer ${token}`;
}

async function normalHeader() {
  const token = await signSession('user-1', SIGNING_KEY);
  return `Bearer ${token}`;
}

describe('content-admin routes', () => {
  const adminUser = { id: 'admin-1', github_login: 'admin-user', avatar_url: null, date_of_birth: null };
  const normalUser = { id: 'user-1', github_login: 'normal-user', avatar_url: null, date_of_birth: null };

  // Auth
  it('returns 401 without auth', async () => {
    const res = await app.request('/v1/admin/stats', {}, env(fakeDB({})));
    expect(res.status).toBe(401);
  });

  it('returns 403 for non-admin user', async () => {
    const res = await app.request('/v1/admin/stats', {
      headers: { Authorization: await normalHeader() },
    }, env(fakeDB({ user: normalUser })));
    expect(res.status).toBe(403);
  });

  // Stats
  it('GET /v1/admin/stats returns platform counts', async () => {
    const db = fakeDB({ user: adminUser, stats: { users: 42 } });
    const res = await app.request('/v1/admin/stats', {
      headers: { Authorization: await adminHeader() },
    }, env(db));
    expect(res.status).toBe(200);
    const data = await res.json() as Record<string, number>;
    expect(typeof data.users).toBe('number');
    expect(typeof data.apps).toBe('number');
  });

  // KV
  it('GET /v1/admin/kv returns entries', async () => {
    const kvEntries = [{ app_id: 'timer', user_id: 'u1', key: 'theme', size: 42, updated_at: 1000 }];
    const res = await app.request('/v1/admin/kv?app=timer', {
      headers: { Authorization: await adminHeader() },
    }, env(fakeDB({ user: adminUser, kvEntries })));
    expect(res.status).toBe(200);
    const data = await res.json() as { entries: unknown[] };
    expect(data.entries).toHaveLength(1);
  });

  it('GET /v1/admin/kv/value returns value', async () => {
    const res = await app.request('/v1/admin/kv/value?app=timer&user=u1&key=theme', {
      headers: { Authorization: await adminHeader() },
    }, env(fakeDB({ user: adminUser, kvValue: { value: '{"color":"blue"}' } })));
    expect(res.status).toBe(200);
  });

  it('GET /v1/admin/kv/value returns 400 without params', async () => {
    const res = await app.request('/v1/admin/kv/value', {
      headers: { Authorization: await adminHeader() },
    }, env(fakeDB({ user: adminUser })));
    expect(res.status).toBe(400);
  });

  it('DELETE /v1/admin/kv returns 400 without params', async () => {
    const res = await app.request('/v1/admin/kv', {
      method: 'DELETE',
      headers: { Authorization: await adminHeader() },
    }, env(fakeDB({ user: adminUser })));
    expect(res.status).toBe(400);
  });

  it('DELETE /v1/admin/kv deletes entry', async () => {
    const res = await app.request('/v1/admin/kv?app=timer&user=u1&key=theme', {
      method: 'DELETE',
      headers: { Authorization: await adminHeader() },
    }, env(fakeDB({ user: adminUser })));
    expect(res.status).toBe(200);
  });

  // Collections
  it('GET /v1/admin/collections returns docs', async () => {
    const docs = [{ id: 'd1', app_id: 'timer', collection: 'posts', data: '{"title":"hi"}', owner_id: 'u1', created_at: 1000, updated_at: 2000 }];
    const res = await app.request('/v1/admin/collections?app=timer', {
      headers: { Authorization: await adminHeader() },
    }, env(fakeDB({ user: adminUser, docs })));
    expect(res.status).toBe(200);
    const data = await res.json() as { documents: unknown[] };
    expect(data.documents).toHaveLength(1);
  });

  it('DELETE /v1/admin/collections returns 400 without params', async () => {
    const res = await app.request('/v1/admin/collections', {
      method: 'DELETE',
      headers: { Authorization: await adminHeader() },
    }, env(fakeDB({ user: adminUser })));
    expect(res.status).toBe(400);
  });

  // Counters
  it('GET /v1/admin/counters returns counters', async () => {
    const counters = [{ app_id: 'timer', name: 'views', value: 100 }];
    const res = await app.request('/v1/admin/counters?app=timer', {
      headers: { Authorization: await adminHeader() },
    }, env(fakeDB({ user: adminUser, counters })));
    expect(res.status).toBe(200);
    const data = await res.json() as { counters: unknown[] };
    expect(data.counters).toHaveLength(1);
  });

  it('DELETE /v1/admin/counters returns 400 without params', async () => {
    const res = await app.request('/v1/admin/counters', {
      method: 'DELETE',
      headers: { Authorization: await adminHeader() },
    }, env(fakeDB({ user: adminUser })));
    expect(res.status).toBe(400);
  });

  // Users
  it('GET /v1/admin/users returns user list with total', async () => {
    const users = [{ id: 'u1', github_login: 'test', avatar_url: null, created_at: 1000 }];
    const res = await app.request('/v1/admin/users', {
      headers: { Authorization: await adminHeader() },
    }, env(fakeDB({ user: adminUser, users, stats: { users: 1 } })));
    expect(res.status).toBe(200);
    const data = await res.json() as { users: unknown[]; total: number };
    expect(data.users).toHaveLength(1);
  });

  // Apps
  it('GET /v1/admin/apps returns app list', async () => {
    const apps = [{ id: 'timer', owner_login: 'admin-user', store: 'apps', category: 'utilities', created_at: 1000 }];
    const res = await app.request('/v1/admin/apps', {
      headers: { Authorization: await adminHeader() },
    }, env(fakeDB({ user: adminUser, apps })));
    expect(res.status).toBe(200);
    const data = await res.json() as { apps: unknown[] };
    expect(data.apps).toHaveLength(1);
  });
});
