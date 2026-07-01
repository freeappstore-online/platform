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
          if (trimmed.includes('FROM apps')) return { ok: 1 };
          if (trimmed.includes('FROM users')) return opts.user ?? null;
          if (trimmed.includes('COUNT(*)'))
            return { cnt: opts.docCount ?? 0, total: opts.docCount ?? 0 };
          if (trimmed.includes('FROM documents') && !trimmed.includes('COUNT'))
            return opts.doc ?? null;
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
    const res = await app.request(
      '/v1/apps/timer/db/posts',
      {
        method: 'POST',
        headers: { Authorization: await authHeader(), 'Content-Type': 'application/json' },
        body: JSON.stringify({ title: 'Hello' }),
      },
      env(fakeDB({ user, docCount: 0 })),
    );
    expect(res.status).toBe(201);
    const data = (await res.json()) as { id: string; title: string };
    expect(data.title).toBe('Hello');
    expect(typeof data.id).toBe('string');
  });

  it('POST returns 404 for an unknown app (quota-reset guard)', async () => {
    // Same harness, but the apps existence lookup returns null.
    const db = {
      prepare: (sql: string) => {
        const trimmed = sql.replace(/\s+/g, ' ').trim();
        const result = {
          first: async () => (trimmed.includes('FROM users') ? user : null),
          all: async () => ({ results: [] }),
          run: async () => ({ meta: { changes: 1 } }),
        };
        return { ...result, bind: (..._a: unknown[]) => result };
      },
    } as unknown as D1Database;
    const res = await app.request(
      '/v1/apps/no-such-app/db/posts',
      {
        method: 'POST',
        headers: { Authorization: await authHeader(), 'Content-Type': 'application/json' },
        body: JSON.stringify({ title: 'Hello' }),
      },
      env(db),
    );
    expect(res.status).toBe(404);
  });

  it('POST create response uses the server id, not a client-supplied id', async () => {
    const res = await app.request(
      '/v1/apps/timer/db/posts',
      {
        method: 'POST',
        headers: { Authorization: await authHeader(), 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: 'client-chosen', title: 'Hello' }),
      },
      env(fakeDB({ user, docCount: 0 })),
    );
    expect(res.status).toBe(201);
    const data = (await res.json()) as { id: string; title: string };
    // The row is stored under a generated id; the response must not echo the
    // client's id (else GET by that id 404s).
    expect(data.id).not.toBe('client-chosen');
  });

  it('POST rejects invalid collection name', async () => {
    const res = await app.request(
      '/v1/apps/timer/db/bad name!',
      {
        method: 'POST',
        headers: { Authorization: await authHeader(), 'Content-Type': 'application/json' },
        body: JSON.stringify({ x: 1 }),
      },
      env(fakeDB({ user })),
    );
    expect(res.status).toBe(400);
  });

  it('POST rejects invalid JSON', async () => {
    const res = await app.request(
      '/v1/apps/timer/db/posts',
      {
        method: 'POST',
        headers: { Authorization: await authHeader(), 'Content-Type': 'text/plain' },
        body: 'not json',
      },
      env(fakeDB({ user })),
    );
    expect(res.status).toBe(400);
  });

  // GET list
  it('GET /v1/apps/:appId/db/:collection lists documents (no auth)', async () => {
    const docs = [
      { id: 'd1', data: '{"title":"hi"}', owner_id: 'u1', created_at: 1000, updated_at: 2000 },
    ];
    const res = await app.request(
      '/v1/apps/timer/db/posts',
      {},
      env(fakeDB({ docs, docCount: 1 })),
    );
    expect(res.status).toBe(200);
    const data = (await res.json()) as { documents: unknown[]; total: number };
    expect(data.documents).toHaveLength(1);
  });

  // GET single
  it('GET /v1/apps/:appId/db/:collection/:id returns a document', async () => {
    const doc = {
      id: 'd1',
      data: '{"title":"hi"}',
      owner_id: 'u1',
      created_at: 1000,
      updated_at: 2000,
    };
    const res = await app.request('/v1/apps/timer/db/posts/d1', {}, env(fakeDB({ doc })));
    expect(res.status).toBe(200);
    const data = (await res.json()) as { id: string; title: string };
    expect(data.title).toBe('hi');
  });

  it('GET /v1/apps/:appId/db/:collection/:id returns 404 for missing doc', async () => {
    const res = await app.request('/v1/apps/timer/db/posts/nope', {}, env(fakeDB({ doc: null })));
    expect(res.status).toBe(404);
  });

  // PUT update
  it('PUT /v1/apps/:appId/db/:collection/:id updates owned document', async () => {
    const doc = { data: '{"title":"old"}', owner_id: 'u1', created_at: 1000 };
    const res = await app.request(
      '/v1/apps/timer/db/posts/d1',
      {
        method: 'PUT',
        headers: { Authorization: await authHeader(), 'Content-Type': 'application/json' },
        body: JSON.stringify({ title: 'new' }),
      },
      env(fakeDB({ user, doc })),
    );
    expect(res.status).toBe(200);
    const data = (await res.json()) as { title: string };
    expect(data.title).toBe('new');
  });

  it('PUT returns 403 for non-owner', async () => {
    const doc = { data: '{"title":"old"}', owner_id: 'other-user', created_at: 1000 };
    const res = await app.request(
      '/v1/apps/timer/db/posts/d1',
      {
        method: 'PUT',
        headers: { Authorization: await authHeader(), 'Content-Type': 'application/json' },
        body: JSON.stringify({ title: 'hack' }),
      },
      env(fakeDB({ user, doc })),
    );
    expect(res.status).toBe(403);
  });

  // DELETE
  it('DELETE /v1/apps/:appId/db/:collection/:id deletes owned document', async () => {
    const doc = { owner_id: 'u1' };
    const res = await app.request(
      '/v1/apps/timer/db/posts/d1',
      {
        method: 'DELETE',
        headers: { Authorization: await authHeader() },
      },
      env(fakeDB({ user, doc })),
    );
    expect(res.status).toBe(204);
  });

  it('DELETE returns 403 for non-owner', async () => {
    const doc = { owner_id: 'other-user' };
    const res = await app.request(
      '/v1/apps/timer/db/posts/d1',
      {
        method: 'DELETE',
        headers: { Authorization: await authHeader() },
      },
      env(fakeDB({ user, doc })),
    );
    expect(res.status).toBe(403);
  });

  // Geo bounding box
  it('GET with bbox params adds json_extract filters', async () => {
    const docs = [
      { id: 'd1', data: '{"lat":1,"lon":2}', owner_id: 'u1', created_at: 1000, updated_at: 2000 },
    ];
    const res = await app.request(
      '/v1/apps/timer/db/posts?lat_min=-10&lat_max=10&lon_min=-20&lon_max=20&limit=50',
      {},
      env(fakeDB({ docs, docCount: 1 })),
    );
    expect(res.status).toBe(200);
    const data = (await res.json()) as { documents: unknown[] };
    expect(data.documents).toHaveLength(1);
  });

  it('GET with bbox rejects non-numeric params', async () => {
    const res = await app.request(
      '/v1/apps/timer/db/posts?lat_min=abc&lat_max=10&lon_min=0&lon_max=20',
      {},
      env(fakeDB({ docs: [] })),
    );
    expect(res.status).toBe(400);
  });

  it('GET with bbox rejects invalid field names', async () => {
    const res = await app.request(
      '/v1/apps/timer/db/posts?lat_min=0&lat_max=10&lon_min=0&lon_max=20&lat_field=lat%27%3B+DROP',
      {},
      env(fakeDB({ docs: [] })),
    );
    expect(res.status).toBe(400);
  });

  it('GET with partial bbox (missing lon) does not filter', async () => {
    const docs = [
      { id: 'd1', data: '{"x":1}', owner_id: 'u1', created_at: 1000, updated_at: 2000 },
    ];
    const res = await app.request(
      '/v1/apps/timer/db/posts?lat_min=0&lat_max=10',
      {},
      env(fakeDB({ docs, docCount: 1 })),
    );
    expect(res.status).toBe(200);
    const data = (await res.json()) as { documents: unknown[] };
    expect(data.documents).toHaveLength(1);
  });
});
