import { describe, expect, it } from 'vitest';
import { app } from '../index.js';
import { signSession } from '../lib/session.js';
import { hasSqlite, sqliteD1 } from '../lib/sqlite-d1.testutil.js';

const SIGNING_KEY = 'a'.repeat(64);

function fakeDB(opts: {
  user?: Record<string, unknown> | null;
  doc?: Record<string, unknown> | null;
  docs?: Array<Record<string, unknown>>;
  docCount?: number;
  /** The collection is marked shared (collection_settings), so anyone may read it (#467). */
  shared?: boolean;
}) {
  return {
    prepare: (sql: string) => {
      const trimmed = sql.replace(/\s+/g, ' ').trim();
      const result = {
        first: async () => {
          if (trimmed.includes('FROM collection_settings'))
            return opts.shared ? { shared: 1 } : null;
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
  const token = await signSession(userId, SIGNING_KEY, { aud: 'console' });
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
    // Time prefix + 80 random bits from crypto, not Math.random (#467).
    expect(data.id).toMatch(/^[0-9a-z]{6,9}[0-9a-f]{20}$/);
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
  it('GET list keeps the row id when the document body also has id', async () => {
    const docs = [
      {
        id: 'server-id',
        data: '{"id":"client-chosen","title":"hi"}',
        owner_id: 'u1',
        created_at: 1000,
        updated_at: 2000,
      },
    ];
    const res = await app.request(
      '/v1/apps/timer/db/posts',
      {},
      env(fakeDB({ docs, docCount: 1, shared: true })),
    );
    expect(res.status).toBe(200);
    const data = (await res.json()) as { documents: Array<{ id: string; title: string }> };
    expect(data.documents[0]?.id).toBe('server-id');
    expect(data.documents[0]?.title).toBe('hi');
  });

  it('GET one keeps the row id when the document body also has id', async () => {
    const doc = {
      id: 'server-id',
      data: '{"id":"client-chosen","title":"hi"}',
      owner_id: 'u1',
      created_at: 1000,
      updated_at: 2000,
    };
    const res = await app.request(
      '/v1/apps/timer/db/posts/server-id',
      { headers: { Authorization: await authHeader() } },
      env(fakeDB({ user, doc, shared: true })),
    );
    expect(res.status).toBe(200);
    const data = (await res.json()) as { id: string; title: string; _owner: string };
    expect(data.id).toBe('server-id');
    expect(data.title).toBe('hi');
    expect(data._owner).toBe('u1');
  });

  it('PUT response keeps the row id when the merged body has id', async () => {
    const doc = { data: '{"id":"stored-id","title":"old"}', owner_id: 'u1', created_at: 1000 };
    const res = await app.request(
      '/v1/apps/timer/db/posts/server-id',
      {
        method: 'PUT',
        headers: { Authorization: await authHeader(), 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: 'patched-id', title: 'new' }),
      },
      env(fakeDB({ user, doc })),
    );
    expect(res.status).toBe(200);
    const data = (await res.json()) as { id: string; title: string };
    expect(data.id).toBe('server-id');
    expect(data.title).toBe('new');
  });

  it('GET /v1/apps/:appId/db/:collection lists documents (no auth)', async () => {
    const docs = [
      { id: 'd1', data: '{"title":"hi"}', owner_id: 'u1', created_at: 1000, updated_at: 2000 },
    ];
    const res = await app.request(
      '/v1/apps/timer/db/posts',
      {},
      env(fakeDB({ docs, docCount: 1, shared: true })),
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
    const res = await app.request(
      '/v1/apps/timer/db/posts/d1',
      {},
      env(fakeDB({ doc, shared: true })),
    );
    expect(res.status).toBe(200);
    const data = (await res.json()) as { id: string; title: string };
    expect(data.title).toBe('hi');
  });

  it('GET /v1/apps/:appId/db/:collection/:id returns 404 for missing doc', async () => {
    const res = await app.request(
      '/v1/apps/timer/db/posts/nope',
      {},
      env(fakeDB({ doc: null, shared: true })),
    );
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
      env(fakeDB({ docs, docCount: 1, shared: true })),
    );
    expect(res.status).toBe(200);
    const data = (await res.json()) as { documents: unknown[] };
    expect(data.documents).toHaveLength(1);
  });

  it('GET with bbox rejects non-numeric params', async () => {
    const res = await app.request(
      '/v1/apps/timer/db/posts?lat_min=abc&lat_max=10&lon_min=0&lon_max=20',
      {},
      env(fakeDB({ docs: [], shared: true })),
    );
    expect(res.status).toBe(400);
  });

  it('GET with bbox rejects invalid field names', async () => {
    const res = await app.request(
      '/v1/apps/timer/db/posts?lat_min=0&lat_max=10&lon_min=0&lon_max=20&lat_field=lat%27%3B+DROP',
      {},
      env(fakeDB({ docs: [], shared: true })),
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
      env(fakeDB({ docs, docCount: 1, shared: true })),
    );
    expect(res.status).toBe(200);
    const data = (await res.json()) as { documents: unknown[] };
    expect(data.documents).toHaveLength(1);
  });
});

describe.skipIf(!hasSqlite)('db list paging against real SQLite', () => {
  it.each(['limit=1.5', 'offset=0.5', 'limit=-5&offset=-1', 'limit=abc'])(
    'GET ?%s returns 200, not a datatype mismatch',
    async (qs) => {
      const { db, d1 } = sqliteD1();
      db.exec(
        "INSERT INTO collection_settings (app_id, collection, shared, updated_at) VALUES ('timer', 'posts', 1, 0)",
      );
      const res = await app.request(`/v1/apps/timer/db/posts?${qs}`, {}, env(d1));
      expect(res.status).toBe(200);
    },
  );
});

/**
 * Private-by-default documents (#467), against real SQLite so the owner filter
 * and the collection_settings lookup are the real SQL.
 */
describe.skipIf(!hasSqlite)('document visibility (#467)', () => {
  async function setup() {
    const { db, d1 } = sqliteD1();
    const now = Date.now();
    for (const [id, ghId, login] of [
      ['gh:1', 1, 'alice'],
      ['gh:2', 2, 'bob'],
    ] as const) {
      db.prepare(
        'INSERT INTO users (id, github_id, github_login, avatar_url, created_at) VALUES (?, ?, ?, NULL, ?)',
      ).run(id, ghId, login, now);
    }
    db.prepare('INSERT INTO apps (id, owner_login, created_at) VALUES (?, ?, ?)').run(
      'timer',
      'alice',
      now,
    );
    const insert = db.prepare(
      'INSERT INTO documents (app_id, collection, id, data, owner_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
    );
    for (const collection of ['notes', 'feed']) {
      insert.run('timer', collection, `${collection}-a`, '{"t":"alice"}', 'gh:1', 1, 1);
      insert.run('timer', collection, `${collection}-b`, '{"t":"bob"}', 'gh:2', 2, 2);
    }
    db.exec(
      "INSERT INTO collection_settings (app_id, collection, shared, updated_at) VALUES ('timer', 'feed', 1, 0)",
    );
    const as = async (userId: string, aud = 'timer') => ({
      Authorization: `Bearer ${await signSession(userId, SIGNING_KEY, { aud })}`,
    });
    const get = (path: string, headers: Record<string, string> = {}) =>
      app.request(`/v1/apps/timer${path}`, { headers }, env(d1));
    return { db, d1, as, get };
  }
  type Docs = { documents: Array<{ id: string; _owner?: string }>; total: number };

  it("a private collection needs a session and lists only the caller's documents", async () => {
    const { as, get } = await setup();
    expect((await get('/db/notes')).status).toBe(401);
    const res = await get('/db/notes', await as('gh:2'));
    const body = (await res.json()) as Docs;
    expect(body.documents.map((d) => d.id)).toEqual(['notes-b']);
    expect(body.total).toBe(1);
    expect(body.documents[0]?._owner).toBe('gh:2');
  });

  it("a private collection hides other users' documents by id, as not found", async () => {
    const { as, get } = await setup();
    expect((await get('/db/notes/notes-a', await as('gh:2'))).status).toBe(404);
    expect((await get('/db/notes/notes-a')).status).toBe(401);
    const own = await get('/db/notes/notes-a', await as('gh:1'));
    expect(own.status).toBe(200);
    expect(((await own.json()) as { _owner: string })._owner).toBe('gh:1');
  });

  it('a stale or foreign token reads as signed out', async () => {
    const { as, get } = await setup();
    expect((await get('/db/notes', await as('gh:1', 'other-app'))).status).toBe(401);
    expect((await get('/db/feed', await as('gh:1', 'other-app'))).status).toBe(200);
  });

  it('a shared collection is readable by anyone but shows _owner only to the owner', async () => {
    const { as, get } = await setup();
    const anon = (await (await get('/db/feed')).json()) as Docs;
    expect(anon.documents.map((d) => d.id).sort()).toEqual(['feed-a', 'feed-b']);
    expect(anon.documents.every((d) => !('_owner' in d))).toBe(true);

    const asBob = (await (await get('/db/feed', await as('gh:2'))).json()) as Docs;
    const owners = Object.fromEntries(asBob.documents.map((d) => [d.id, d._owner]));
    expect(owners).toEqual({ 'feed-a': undefined, 'feed-b': 'gh:2' });

    const one = (await (await get('/db/feed/feed-a', await as('gh:2'))).json()) as Record<
      string,
      unknown
    >;
    expect('_owner' in one).toBe(false);
  });

  it('never exposes an _owner stored inside the document body', async () => {
    const { db, get } = await setup();
    db.prepare('UPDATE documents SET data = ? WHERE id = ?').run(
      '{"_owner":"gh:1","t":"x"}',
      'feed-a',
    );
    const one = (await (await get('/db/feed/feed-a')).json()) as Record<string, unknown>;
    expect('_owner' in one).toBe(false);
  });

  it('?owner= is limited to the caller, in private and shared collections', async () => {
    const { as, get } = await setup();
    for (const collection of ['notes', 'feed']) {
      expect((await get(`/db/${collection}?owner=gh:1`, await as('gh:2'))).status).toBe(403);
      expect((await get(`/db/${collection}?owner=gh:1`)).status).toBe(401);
      const own = (await (
        await get(`/db/${collection}?owner=gh:2`, await as('gh:2'))
      ).json()) as Docs;
      expect(own.documents.map((d) => d.id)).toEqual([`${collection}-b`]);
    }
  });

  it('writes stay owner-only', async () => {
    const { d1, as } = await setup();
    const res = await app.request(
      '/v1/apps/timer/db/feed/feed-a',
      {
        method: 'PUT',
        headers: { ...(await as('gh:2')), 'Content-Type': 'application/json' },
        body: '{}',
      },
      env(d1),
    );
    expect(res.status).toBe(403);
  });

  describe('marking a collection shared', () => {
    const put = (d1: D1Database, headers: Record<string, string>, name: string, body: unknown) =>
      app.request(
        `/v1/apps/timer/collections/${name}`,
        {
          method: 'PUT',
          headers: { ...headers, 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        },
        env(d1),
      );

    it('is an app-owner action on a console session', async () => {
      const { d1, as } = await setup();
      expect((await put(d1, await as('gh:2', 'console'), 'notes', { shared: true })).status).toBe(
        403,
      );
      expect((await put(d1, await as('gh:1', 'timer'), 'notes', { shared: true })).status).toBe(
        403,
      );
      expect((await put(d1, await as('gh:1', 'console'), 'notes', { shared: true })).status).toBe(
        204,
      );
    });

    it('opens the collection to other users, and sharing off closes it again', async () => {
      const { d1, as, get } = await setup();
      const owner = await as('gh:1', 'console');
      await put(d1, owner, 'notes', { shared: true });
      const open = (await (await get('/db/notes', await as('gh:2'))).json()) as Docs;
      expect(open.documents).toHaveLength(2);

      expect((await put(d1, owner, 'notes', { shared: false })).status).toBe(204);
      const closed = (await (await get('/db/notes', await as('gh:2'))).json()) as Docs;
      expect(closed.documents.map((d) => d.id)).toEqual(['notes-b']);
    });

    it('lists the shared collections and validates the request', async () => {
      const { d1, as } = await setup();
      const owner = await as('gh:1', 'console');
      expect((await put(d1, owner, 'notes', { shared: 'yes' })).status).toBe(400);
      expect((await put(d1, owner, 'bad name', { shared: true })).status).toBe(400);
      const list = await app.request('/v1/apps/timer/collections', { headers: owner }, env(d1));
      expect(((await list.json()) as { shared: Array<{ collection: string }> }).shared).toEqual([
        expect.objectContaining({ collection: 'feed' }),
      ]);
    });

    it('caps the shared collections per app', async () => {
      const { db, d1, as } = await setup();
      const ins = db.prepare(
        'INSERT INTO collection_settings (app_id, collection, shared, updated_at) VALUES (?, ?, 1, 0)',
      );
      for (let i = 0; i < 49; i++) ins.run('timer', `c${i}`);
      const owner = await as('gh:1', 'console');
      expect((await put(d1, owner, 'one-too-many', { shared: true })).status).toBe(409);
      // An already-shared collection is not a new row.
      expect((await put(d1, owner, 'c1', { shared: true })).status).toBe(204);
    });
  });
});
