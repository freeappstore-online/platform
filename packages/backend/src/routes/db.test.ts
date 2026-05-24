import { describe, expect, it } from 'vitest';
import { app } from '../index.js';
import { signSession } from '../lib/session.js';

const SIGNING_KEY = 'a'.repeat(64);

function fakeDB(opts: {
  user?: Record<string, unknown> | null;
  doc?: Record<string, unknown> | null;
  docs?: Array<Record<string, unknown>>;
  docCount?: number;
}) {
  return {
    prepare: (sql: string) => {
      const trimmed = sql.replace(/\s+/g, ' ').trim();
      const result = {
        first: async () => {
          if (trimmed.includes('FROM users')) return opts.user ?? null;
          if (trimmed.includes('COUNT(*)')) return { cnt: opts.docCount ?? 0, total: opts.docCount ?? 0 };
          if (trimmed.includes('FROM documents') && !trimmed.includes('COUNT')) return opts.doc ?? null;
          return null;
        },
        all: async () => {
          if (trimmed.includes('FROM documents')) return { results: opts.docs ?? [] };
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

describe('db (collections) routes', () => {
  const user = { id: 'u1', github_login: 'test', avatar_url: null, date_of_birth: null };

  // POST create
  it('POST /v1/apps/:appId/db/:collection returns 401 without auth', async () => {
    const res = await app.request('/v1/apps/timer/db/posts', { method: 'POST' }, env(fakeDB({})));
    expect(res.status).toBe(401);
  });

  it('POST /v1/apps/:appId/db/:collection creates a document', async () => {
    const res = await app.request('/v1/apps/timer/db/posts', {
      method: 'POST',
      headers: { Authorization: await authHeader(), 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: 'Hello' }),
    }, env(fakeDB({ user, docCount: 0 })));
    expect(res.status).toBe(201);
    const data = await res.json() as { id: string; title: string };
    expect(data.title).toBe('Hello');
    expect(typeof data.id).toBe('string');
  });

  it('POST rejects invalid collection name', async () => {
    const res = await app.request('/v1/apps/timer/db/bad name!', {
      method: 'POST',
      headers: { Authorization: await authHeader(), 'Content-Type': 'application/json' },
      body: JSON.stringify({ x: 1 }),
    }, env(fakeDB({ user })));
    expect(res.status).toBe(400);
  });

  it('POST rejects invalid JSON', async () => {
    const res = await app.request('/v1/apps/timer/db/posts', {
      method: 'POST',
      headers: { Authorization: await authHeader(), 'Content-Type': 'text/plain' },
      body: 'not json',
    }, env(fakeDB({ user })));
    expect(res.status).toBe(400);
  });

  // GET list
  it('GET /v1/apps/:appId/db/:collection lists documents (no auth)', async () => {
    const docs = [{ id: 'd1', data: '{"title":"hi"}', owner_id: 'u1', created_at: 1000, updated_at: 2000 }];
    const res = await app.request('/v1/apps/timer/db/posts', {}, env(fakeDB({ docs, docCount: 1 })));
    expect(res.status).toBe(200);
    const data = await res.json() as { documents: unknown[]; total: number };
    expect(data.documents).toHaveLength(1);
  });

  // GET single
  it('GET /v1/apps/:appId/db/:collection/:id returns a document', async () => {
    const doc = { id: 'd1', data: '{"title":"hi"}', owner_id: 'u1', created_at: 1000, updated_at: 2000 };
    const res = await app.request('/v1/apps/timer/db/posts/d1', {}, env(fakeDB({ doc })));
    expect(res.status).toBe(200);
    const data = await res.json() as { id: string; title: string };
    expect(data.title).toBe('hi');
  });

  it('GET /v1/apps/:appId/db/:collection/:id returns 404 for missing doc', async () => {
    const res = await app.request('/v1/apps/timer/db/posts/nope', {}, env(fakeDB({ doc: null })));
    expect(res.status).toBe(404);
  });

  // PUT update
  it('PUT /v1/apps/:appId/db/:collection/:id updates owned document', async () => {
    const doc = { data: '{"title":"old"}', owner_id: 'u1', created_at: 1000 };
    const res = await app.request('/v1/apps/timer/db/posts/d1', {
      method: 'PUT',
      headers: { Authorization: await authHeader(), 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: 'new' }),
    }, env(fakeDB({ user, doc })));
    expect(res.status).toBe(200);
    const data = await res.json() as { title: string };
    expect(data.title).toBe('new');
  });

  it('PUT returns 403 for non-owner', async () => {
    const doc = { data: '{"title":"old"}', owner_id: 'other-user', created_at: 1000 };
    const res = await app.request('/v1/apps/timer/db/posts/d1', {
      method: 'PUT',
      headers: { Authorization: await authHeader(), 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: 'hack' }),
    }, env(fakeDB({ user, doc })));
    expect(res.status).toBe(403);
  });

  // DELETE
  it('DELETE /v1/apps/:appId/db/:collection/:id deletes owned document', async () => {
    const doc = { owner_id: 'u1' };
    const res = await app.request('/v1/apps/timer/db/posts/d1', {
      method: 'DELETE',
      headers: { Authorization: await authHeader() },
    }, env(fakeDB({ user, doc })));
    expect(res.status).toBe(204);
  });

  it('DELETE returns 403 for non-owner', async () => {
    const doc = { owner_id: 'other-user' };
    const res = await app.request('/v1/apps/timer/db/posts/d1', {
      method: 'DELETE',
      headers: { Authorization: await authHeader() },
    }, env(fakeDB({ user, doc })));
    expect(res.status).toBe(403);
  });
});
