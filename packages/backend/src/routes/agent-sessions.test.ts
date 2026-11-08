import { describe, expect, it } from 'vitest';
import { app } from '../index.js';
import { signSession } from '../lib/session.js';
import { hasSqlite, sqliteD1 } from '../lib/sqlite-d1.testutil.js';

const SIGNING_KEY = 'a'.repeat(64);

function fakeDB(opts: {
  user?: {
    id: string;
    github_login: string;
    avatar_url: string | null;
    date_of_birth: string | null;
  } | null;
  sessions?: Array<Record<string, unknown>>;
  session?: Record<string, unknown> | null;
}) {
  const calls: Array<{ sql: string; bound: unknown[] }> = [];
  const prepare = (sql: string) => {
    const trimmed = sql.replace(/\s+/g, ' ').trim();
    const bound = (args: unknown[]) => ({
      _sql: trimmed,
      _bound: args,
      first: first as any,
      all,
      run,
    });
    return {
      bind: (...args: unknown[]) => bound(args),
      first: first as any,
      all,
      run,
      _sql: trimmed,
      _bound: [] as unknown[],
    };
    async function first<T>() {
      if (trimmed.includes('FROM users')) return (opts.user ?? null) as T;
      if (trimmed.includes('FROM agent_sessions') && trimmed.includes('session_id = ?'))
        return (opts.session ?? null) as T;
      return null as T;
    }
    async function all() {
      if (trimmed.includes('FROM agent_sessions')) return { results: opts.sessions ?? [] };
      return { results: [] };
    }
    async function run() {
      return { meta: { changes: 1 } };
    }
  };
  const batch = async (stmts: Array<{ _sql: string; _bound: unknown[] }>) => {
    for (const s of stmts) calls.push({ sql: s._sql, bound: s._bound });
    return stmts.map(() => ({ meta: { changes: 1 } }));
  };
  return { prepare, batch, _calls: calls } as unknown as D1Database;
}

function env(db: D1Database): Record<string, unknown> {
  return { DB: db, SESSION_SIGNING_KEY: SIGNING_KEY };
}

async function authHeader(userId = 'user-1') {
  const token = await signSession(userId, SIGNING_KEY, { aud: 'console' });
  return `Bearer ${token}`;
}

describe('agent-sessions', () => {
  const user = { id: 'user-1', github_login: 'testuser', avatar_url: null, date_of_birth: null };

  it('GET /v1/agent/sessions returns 401 without auth', async () => {
    const res = await app.request('/v1/agent/sessions', {}, env(fakeDB({ user: null })));
    expect(res.status).toBe(401);
  });

  it('GET /v1/agent/sessions returns sessions list', async () => {
    const sessions = [
      {
        session_id: 's1',
        name: 'App 1',
        app_id: null,
        app_url: null,
        deployed: 0,
        created_at: 1000,
        updated_at: 2000,
      },
    ];
    const db = fakeDB({ user, sessions });
    const res = await app.request(
      '/v1/agent/sessions',
      { headers: { Authorization: await authHeader() } },
      env(db),
    );
    expect(res.status).toBe(200);
    const data = (await res.json()) as { sessions: unknown[] };
    expect(data.sessions).toHaveLength(1);
  });

  it('GET /v1/agent/sessions/:id returns session with messages', async () => {
    const session = {
      session_id: 's1',
      user_id: 'user-1',
      name: 'Test',
      app_id: null,
      app_url: null,
      deployed: 0,
      messages: '[{"role":"user","content":"hello"}]',
      deploy_state: null,
      created_at: 1000,
      updated_at: 2000,
    };
    const db = fakeDB({ user, session });
    const res = await app.request(
      '/v1/agent/sessions/s1',
      { headers: { Authorization: await authHeader() } },
      env(db),
    );
    expect(res.status).toBe(200);
    const data = (await res.json()) as { session: { messages: unknown[] } };
    expect(data.session.messages).toHaveLength(1);
  });

  it('GET /v1/agent/sessions/:id tolerates malformed persisted JSON', async () => {
    const session = {
      session_id: 's1',
      user_id: 'user-1',
      name: 'Test',
      app_id: null,
      app_url: null,
      deployed: 0,
      messages: '{bad',
      deploy_state: '{bad',
      deploy_log: '{bad',
      errors: '{bad',
      created_at: 1000,
      updated_at: 2000,
    };
    const db = fakeDB({ user, session });
    const res = await app.request(
      '/v1/agent/sessions/s1',
      { headers: { Authorization: await authHeader() } },
      env(db),
    );
    expect(res.status).toBe(200);
    const data = (await res.json()) as {
      session: {
        messages: unknown[];
        deployState: unknown;
        deployLog: unknown[];
        errors: unknown[];
      };
    };
    expect(data.session.messages).toEqual([]);
    expect(data.session.deployState).toBeNull();
    expect(data.session.deployLog).toEqual([]);
    expect(data.session.errors).toEqual([]);
  });

  it('GET /v1/agent/sessions/:id returns null for nonexistent', async () => {
    const db = fakeDB({ user, session: null });
    const res = await app.request(
      '/v1/agent/sessions/nope',
      { headers: { Authorization: await authHeader() } },
      env(db),
    );
    expect(res.status).toBe(200);
    const data = (await res.json()) as { session: null };
    expect(data.session).toBeNull();
  });

  it('PUT /v1/agent/sessions/:id creates session', async () => {
    const db = fakeDB({ user });
    const res = await app.request(
      '/v1/agent/sessions/s2',
      {
        method: 'PUT',
        headers: { Authorization: await authHeader(), 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'My App', messages: [{ role: 'user', content: 'hi' }] }),
      },
      env(db),
    );
    expect(res.status).toBe(200);
    const data = (await res.json()) as { ok: boolean };
    expect(data.ok).toBe(true);
  });

  it('PUT /v1/agent/sessions/:id preserves omitted deployed (binds null, not 0)', async () => {
    const db = fakeDB({ user });
    const res = await app.request(
      '/v1/agent/sessions/s3',
      {
        method: 'PUT',
        headers: { Authorization: await authHeader(), 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'Renamed' }), // deployed + appId etc. omitted
      },
      env(db),
    );
    expect(res.status).toBe(200);
    const calls = (db as unknown as { _calls: Array<{ sql: string; bound: unknown[] }> })._calls;
    const update = calls.find((c) => c.sql.includes('UPDATE agent_sessions'));
    expect(update).toBeTruthy();
    expect(update?.sql).toContain('deployed = COALESCE(?, deployed)');
    // UPDATE bind order: name, app_id, app_url, deployed, messages, deploy_state, now, id, user
    expect(update?.bound[0]).toBe('Renamed'); // supplied → set
    expect(update?.bound[3]).toBeNull(); // deployed omitted → null → COALESCE preserves prior
    expect(update?.bound[1]).toBeNull(); // app_id omitted → preserved
  });

  it('PUT /v1/agent/sessions/:id/messages updates messages', async () => {
    const db = fakeDB({ user });
    const res = await app.request(
      '/v1/agent/sessions/s1/messages',
      {
        method: 'PUT',
        headers: { Authorization: await authHeader(), 'Content-Type': 'application/json' },
        body: JSON.stringify({ messages: [{ role: 'assistant', content: 'done' }] }),
      },
      env(db),
    );
    expect(res.status).toBe(200);
  });

  it('DELETE /v1/agent/sessions/:id deletes session', async () => {
    const db = fakeDB({ user });
    const res = await app.request(
      '/v1/agent/sessions/s1',
      {
        method: 'DELETE',
        headers: { Authorization: await authHeader() },
      },
      env(db),
    );
    expect(res.status).toBe(200);
    const data = (await res.json()) as { ok: boolean };
    expect(data.ok).toBe(true);
  });
});

describe.skipIf(!hasSqlite)('PUT /v1/agent/sessions/:id validation (#491)', () => {
  function setup() {
    const { db, d1 } = sqliteD1();
    const now = Date.now();
    const users = db.prepare(
      'INSERT INTO users (id, github_id, github_login, avatar_url, created_at) VALUES (?, ?, ?, NULL, ?)',
    );
    users.run('gh:1', 1, 'alice', now);
    users.run('gh:2', 2, 'bob', now);
    db.prepare('INSERT INTO apps (id, owner_login, created_at) VALUES (?, ?, ?)').run(
      'timer',
      'alice',
      now,
    );
    const put = async (userId: string, id: string, body: unknown) =>
      app.request(
        `/v1/agent/sessions/${id}`,
        {
          method: 'PUT',
          headers: {
            Authorization: await authHeader(userId),
            'Content-Type': 'application/json',
          },
          body: typeof body === 'string' ? body : JSON.stringify(body),
        },
        { DB: d1, SESSION_SIGNING_KEY: SIGNING_KEY },
      );
    const row = (id: string) =>
      db.prepare('SELECT app_id, name FROM agent_sessions WHERE session_id = ?').get(id) as
        | { app_id: string | null; name: string }
        | undefined;
    return { put, row, db };
  }

  it('lets the owner attach their app, and nobody else', async () => {
    const { put, row } = setup();
    expect((await put('gh:1', 's1', { name: 'Timer', appId: 'timer' })).status).toBe(200);
    expect(row('s1')?.app_id).toBe('timer');
    expect((await put('gh:2', 's2', { name: 'Fake timer', appId: 'timer' })).status).toBe(403);
    expect(row('s2')).toBeUndefined();
    expect((await put('gh:2', 's3', { appId: 'ghost' })).status).toBe(404);
    expect(row('s3')).toBeUndefined();
  });

  it('rejects a malformed appId, an over-long name, and non-string/non-array fields', async () => {
    const { put, row } = setup();
    const bad: Array<[string, unknown]> = [
      ['appId shape', { appId: 'Not_An_Id' }],
      ['appId type', { appId: 42 }],
      ['name length', { name: 'x'.repeat(201) }],
      ['name type', { name: { nested: true } }],
      ['appUrl type', { appUrl: ['https://x'] }],
      ['deployed type', { deployed: 'yes' }],
      ['messages type', { messages: 'hi' }],
      ['deployState type', { deployState: 'live' }],
    ];
    for (const [label, body] of bad) {
      expect((await put('gh:1', 's1', body)).status, label).toBe(400);
    }
    expect(row('s1')).toBeUndefined();
  });

  it('rejects a body over 2 MB before touching the database', async () => {
    const { put, row } = setup();
    const res = await put('gh:1', 's1', { messages: [{ content: 'x'.repeat(2_000_001) }] });
    expect(res.status).toBe(413);
    expect(row('s1')).toBeUndefined();
  });

  it('counts bytes, not characters, against the 2 MB cap (#569)', async () => {
    const { put, row } = setup();
    // 700k three-byte characters: 700k chars but 2.1 MB.
    const res = await put('gh:1', 's1', { messages: [{ content: '\u20ac'.repeat(700_000) }] });
    expect(res.status).toBe(413);
    expect(row('s1')).toBeUndefined();
  });

  it('caps sessions per user and total stored bytes (#569)', async () => {
    const { put, row } = setup();
    for (let i = 0; i < 200; i++)
      expect((await put('gh:1', `s${i}`, { name: 'n' })).status).toBe(200);
    expect((await put('gh:1', 'one-too-many', { name: 'n' })).status).toBe(429);
    expect(row('one-too-many')).toBeUndefined();
    // Updating an existing session is still fine, and other users are unaffected.
    expect((await put('gh:1', 's0', { name: 'renamed' })).status).toBe(200);
    expect((await put('gh:2', 'bobs', { name: 'n' })).status).toBe(200);
  });

  it('refuses writes once a user stores 100 MB of messages (#569)', async () => {
    const { put, db } = setup();
    db.prepare(
      "INSERT INTO agent_sessions (session_id, user_id, messages, created_at, updated_at) VALUES ('fat', 'gh:1', hex(zeroblob(49500000)), 1, 1)",
    ).run();
    const big = [{ content: 'x'.repeat(1_900_000) }];
    expect((await put('gh:1', 'next', { messages: big })).status).toBe(413);
    expect((await put('gh:2', 'bobs', { messages: big })).status).toBe(200);
  }, 30_000);
});
