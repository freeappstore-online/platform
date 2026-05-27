import { describe, expect, it } from 'vitest';
import { app } from '../index.js';
import { signSession } from '../lib/session.js';

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
  const prepare = (sql: string) => {
    const trimmed = sql.replace(/\s+/g, ' ').trim();
    let _bound: unknown[] = [];
    return {
      bind: (...args: unknown[]) => {
        _bound = args;
        return { first: first as any, all, run };
      },
      first: first as any,
      all,
      run,
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
  return { prepare } as unknown as D1Database;
}

function env(db: D1Database): Record<string, unknown> {
  return { DB: db, SESSION_SIGNING_KEY: SIGNING_KEY };
}

async function authHeader(userId = 'user-1') {
  const token = await signSession(userId, SIGNING_KEY);
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
