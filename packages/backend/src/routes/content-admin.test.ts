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
  sessions?: Array<Record<string, unknown>>;
  apps?: Array<Record<string, unknown>>;
  routes?: Array<Record<string, unknown>>;
  stats?: Record<string, number>;
  kvValue?: Record<string, unknown> | null;
}) {
  return {
    prepare: (sql: string) => {
      const trimmed = sql.replace(/\s+/g, ' ').trim();
      const stmtResult = {
        first: async () => {
          if (trimmed.includes('FROM agent_sessions')) return opts.sessions?.[0] ?? null;
          if (trimmed.includes('FROM users')) return opts.user ?? null;
          if (trimmed.includes('FROM kv') && trimmed.includes('value FROM'))
            return opts.kvValue ?? null;
          if (trimmed.includes('COUNT(*)')) return { n: opts.stats?.users ?? 0 };
          return null;
        },
        all: async () => {
          if (trimmed.includes('FROM kv')) return { results: opts.kvEntries ?? [] };
          if (trimmed.includes('FROM documents')) return { results: opts.docs ?? [] };
          if (trimmed.includes('FROM counters')) return { results: opts.counters ?? [] };
          if (trimmed.includes('FROM agent_sessions')) return { results: opts.sessions ?? [] };
          if (trimmed.includes('FROM routes')) return { results: opts.routes ?? [] };
          if (trimmed.includes('FROM users')) return { results: opts.users ?? [] };
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

function env(db: D1Database, overrides: Record<string, unknown> = {}) {
  return { DB: db, SESSION_SIGNING_KEY: SIGNING_KEY, ...overrides };
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
  const adminUser = {
    id: 'admin-1',
    github_login: 'admin-user',
    avatar_url: null,
    date_of_birth: null,
  };
  const normalUser = {
    id: 'user-1',
    github_login: 'normal-user',
    avatar_url: null,
    date_of_birth: null,
  };

  // Auth
  it('returns 401 without auth', async () => {
    const res = await app.request('/v1/admin/stats', {}, env(fakeDB({})));
    expect(res.status).toBe(401);
  });

  it('returns 403 for non-admin user', async () => {
    const res = await app.request(
      '/v1/admin/stats',
      {
        headers: { Authorization: await normalHeader() },
      },
      env(fakeDB({ user: normalUser })),
    );
    expect(res.status).toBe(403);
  });

  // Stats
  it('GET /v1/admin/stats returns platform counts', async () => {
    const db = fakeDB({ user: adminUser, stats: { users: 42 } });
    const res = await app.request(
      '/v1/admin/stats',
      {
        headers: { Authorization: await adminHeader() },
      },
      env(db),
    );
    expect(res.status).toBe(200);
    const data = (await res.json()) as Record<string, number>;
    expect(typeof data.users).toBe('number');
    expect(typeof data.apps).toBe('number');
  });

  it('GET /v1/admin/agent-sessions includes user names', async () => {
    const sessions = [
      {
        session_id: 's1',
        user_id: 'gh:1',
        github_login: 'alice',
        display_name: 'Alice Example',
        name: 'New App',
        app_id: null,
        app_url: null,
        deployed: 0,
        deploy_state: null,
        created_at: 1000,
        updated_at: 2000,
      },
    ];
    const res = await app.request(
      '/v1/admin/agent-sessions',
      {
        headers: { Authorization: await adminHeader() },
      },
      env(fakeDB({ user: adminUser, sessions, stats: { users: 1 } })),
    );
    expect(res.status).toBe(200);
    const data = (await res.json()) as {
      sessions: Array<{ userLogin: string; userDisplayName: string }>;
    };
    expect(data.sessions[0]!.userLogin).toBe('alice');
    expect(data.sessions[0]!.userDisplayName).toBe('Alice Example');
  });

  it('GET /v1/admin/agent-sessions tolerates malformed deploy state', async () => {
    const sessions = [
      {
        session_id: 's1',
        user_id: 'gh:1',
        github_login: 'alice',
        display_name: 'Alice Example',
        name: 'New App',
        app_id: null,
        app_url: null,
        deployed: 0,
        deploy_state: '{bad',
        created_at: 1000,
        updated_at: 2000,
      },
    ];
    const res = await app.request(
      '/v1/admin/agent-sessions',
      {
        headers: { Authorization: await adminHeader() },
      },
      env(fakeDB({ user: adminUser, sessions, stats: { users: 1 } })),
    );
    expect(res.status).toBe(200);
    const data = (await res.json()) as { sessions: Array<{ deployState: unknown }> };
    expect(data.sessions[0]!.deployState).toBeNull();
  });

  it('GET /v1/admin/agent-sessions/:id includes user names and debug data', async () => {
    const sessions = [
      {
        session_id: 's1',
        user_id: 'gh:1',
        github_login: 'alice',
        display_name: 'Alice Example',
        name: 'New App',
        app_id: 'demo',
        app_url: 'https://demo.freeappstore.online',
        deployed: 1,
        messages: '[{"role":"user","content":"hi"}]',
        deploy_state: '{"phase":"live"}',
        deploy_log: '[{"phase":"live","detail":"ok"}]',
        errors: '[{"source":"agent","message":"x"}]',
        created_at: 1000,
        updated_at: 2000,
      },
    ];
    const res = await app.request(
      '/v1/admin/agent-sessions/s1',
      {
        headers: { Authorization: await adminHeader() },
      },
      env(fakeDB({ user: adminUser, sessions })),
    );
    expect(res.status).toBe(200);
    const data = (await res.json()) as {
      session: { userLogin: string; userDisplayName: string; messages: unknown[] };
    };
    expect(data.session.userLogin).toBe('alice');
    expect(data.session.userDisplayName).toBe('Alice Example');
    expect(data.session.messages).toHaveLength(1);
  });

  it('GET /v1/admin/agent-sessions/:id tolerates malformed debug JSON', async () => {
    const sessions = [
      {
        session_id: 's1',
        user_id: 'gh:1',
        github_login: 'alice',
        display_name: 'Alice Example',
        name: 'New App',
        app_id: 'demo',
        app_url: 'https://demo.freeappstore.online',
        deployed: 1,
        messages: '{bad',
        deploy_state: '{bad',
        deploy_log: '{bad',
        errors: '{bad',
        created_at: 1000,
        updated_at: 2000,
      },
    ];
    const res = await app.request(
      '/v1/admin/agent-sessions/s1',
      {
        headers: { Authorization: await adminHeader() },
      },
      env(fakeDB({ user: adminUser, sessions })),
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

  // KV
  it('GET /v1/admin/kv returns entries', async () => {
    const kvEntries = [
      { app_id: 'timer', user_id: 'u1', key: 'theme', size: 42, updated_at: 1000 },
    ];
    const res = await app.request(
      '/v1/admin/kv?app=timer',
      {
        headers: { Authorization: await adminHeader() },
      },
      env(fakeDB({ user: adminUser, kvEntries })),
    );
    expect(res.status).toBe(200);
    const data = (await res.json()) as { entries: unknown[] };
    expect(data.entries).toHaveLength(1);
  });

  it('GET /v1/admin/kv/value returns value', async () => {
    const res = await app.request(
      '/v1/admin/kv/value?app=timer&user=u1&key=theme',
      {
        headers: { Authorization: await adminHeader() },
      },
      env(fakeDB({ user: adminUser, kvValue: { value: '{"color":"blue"}' } })),
    );
    expect(res.status).toBe(200);
    const data = (await res.json()) as { value: { color: string } };
    expect(data.value.color).toBe('blue');
  });

  it('GET /v1/admin/kv/value tolerates malformed JSON', async () => {
    const res = await app.request(
      '/v1/admin/kv/value?app=timer&user=u1&key=theme',
      {
        headers: { Authorization: await adminHeader() },
      },
      env(fakeDB({ user: adminUser, kvValue: { value: '{bad' } })),
    );
    expect(res.status).toBe(200);
    const data = (await res.json()) as { value: unknown };
    expect(data.value).toBeNull();
  });

  it('GET /v1/admin/kv/value returns 400 without params', async () => {
    const res = await app.request(
      '/v1/admin/kv/value',
      {
        headers: { Authorization: await adminHeader() },
      },
      env(fakeDB({ user: adminUser })),
    );
    expect(res.status).toBe(400);
  });

  it('DELETE /v1/admin/kv returns 400 without params', async () => {
    const res = await app.request(
      '/v1/admin/kv',
      {
        method: 'DELETE',
        headers: { Authorization: await adminHeader() },
      },
      env(fakeDB({ user: adminUser })),
    );
    expect(res.status).toBe(400);
  });

  it('DELETE /v1/admin/kv deletes entry', async () => {
    const res = await app.request(
      '/v1/admin/kv?app=timer&user=u1&key=theme',
      {
        method: 'DELETE',
        headers: { Authorization: await adminHeader() },
      },
      env(fakeDB({ user: adminUser })),
    );
    expect(res.status).toBe(200);
  });

  // Collections
  it('GET /v1/admin/collections returns docs', async () => {
    const docs = [
      {
        id: 'd1',
        app_id: 'timer',
        collection: 'posts',
        data: '{"title":"hi"}',
        owner_id: 'u1',
        created_at: 1000,
        updated_at: 2000,
      },
    ];
    const res = await app.request(
      '/v1/admin/collections?app=timer',
      {
        headers: { Authorization: await adminHeader() },
      },
      env(fakeDB({ user: adminUser, docs })),
    );
    expect(res.status).toBe(200);
    const data = (await res.json()) as { documents: unknown[] };
    expect(data.documents).toHaveLength(1);
  });

  it('GET /v1/admin/collections tolerates malformed document JSON', async () => {
    const docs = [
      {
        id: 'd1',
        app_id: 'timer',
        collection: 'posts',
        data: '{bad',
        owner_id: 'u1',
        created_at: 1000,
        updated_at: 2000,
      },
    ];
    const res = await app.request(
      '/v1/admin/collections?app=timer',
      {
        headers: { Authorization: await adminHeader() },
      },
      env(fakeDB({ user: adminUser, docs })),
    );
    expect(res.status).toBe(200);
    const data = (await res.json()) as { documents: Array<{ data: unknown }> };
    expect(data.documents[0]!.data).toBeNull();
  });

  it('DELETE /v1/admin/collections returns 400 without params', async () => {
    const res = await app.request(
      '/v1/admin/collections',
      {
        method: 'DELETE',
        headers: { Authorization: await adminHeader() },
      },
      env(fakeDB({ user: adminUser })),
    );
    expect(res.status).toBe(400);
  });

  // Counters
  it('GET /v1/admin/counters returns counters', async () => {
    const counters = [{ app_id: 'timer', name: 'views', value: 100 }];
    const res = await app.request(
      '/v1/admin/counters?app=timer',
      {
        headers: { Authorization: await adminHeader() },
      },
      env(fakeDB({ user: adminUser, counters })),
    );
    expect(res.status).toBe(200);
    const data = (await res.json()) as { counters: unknown[] };
    expect(data.counters).toHaveLength(1);
  });

  it('DELETE /v1/admin/counters returns 400 without params', async () => {
    const res = await app.request(
      '/v1/admin/counters',
      {
        method: 'DELETE',
        headers: { Authorization: await adminHeader() },
      },
      env(fakeDB({ user: adminUser })),
    );
    expect(res.status).toBe(400);
  });

  // Users
  it('GET /v1/admin/users returns user list with total', async () => {
    const users = [{ id: 'u1', github_login: 'test', avatar_url: null, created_at: 1000 }];
    const res = await app.request(
      '/v1/admin/users',
      {
        headers: { Authorization: await adminHeader() },
      },
      env(fakeDB({ user: adminUser, users, stats: { users: 1 } })),
    );
    expect(res.status).toBe(200);
    const data = (await res.json()) as { users: unknown[]; total: number };
    expect(data.users).toHaveLength(1);
  });

  // Apps
  it('GET /v1/admin/apps returns app list', async () => {
    const apps = [
      {
        id: 'timer',
        owner_login: 'admin-user',
        store: 'apps',
        category: 'utilities',
        type: 'standalone',
        oneliner: 'Fast timer',
        repo: null,
        created_at: 1000,
      },
    ];
    const routes = [
      {
        slug: 'timer',
        zone: 'freeappstore.online',
        r2_prefix: 'apps/timer',
        store: 'apps',
        hosted_on: 'r2',
        created_at: 1000,
        updated_at: '2026-05-23 20:36:02',
      },
    ];
    const sessions = [
      {
        session_id: 's1',
        app_id: 'timer',
        name: 'Timer App',
        app_url: 'https://timer.freeappstore.online',
        deployed: 1,
        deploy_state: '{"phase":"live"}',
        updated_at: 4000,
      },
    ];
    const users = [
      {
        github_login: 'admin-user',
        display_name: 'Admin User',
        avatar_url: 'https://example.com/avatar.png',
      },
    ];
    const res = await app.request(
      '/v1/admin/apps',
      {
        headers: { Authorization: await adminHeader() },
      },
      env(fakeDB({ user: adminUser, apps, routes, sessions, users })),
    );
    expect(res.status).toBe(200);
    const data = (await res.json()) as {
      apps: Array<{
        id: string;
        domain: string;
        ownerDisplayName: string;
        sessionCount: number;
        latestSession: { sessionId: string; deployed: boolean };
        updatedAt: number;
      }>;
    };
    expect(data.apps).toHaveLength(1);
    expect(data.apps[0]!.id).toBe('timer');
    expect(data.apps[0]!.domain).toBe('timer.freeappstore.online');
    expect(data.apps[0]!.ownerDisplayName).toBe('Admin User');
    expect(data.apps[0]!.sessionCount).toBe(1);
    expect(data.apps[0]!.latestSession.sessionId).toBe('s1');
    expect(data.apps[0]!.latestSession.deployed).toBe(true);
    expect(data.apps[0]!.updatedAt).toBeGreaterThan(0);
  });

  it('GET /v1/admin/creators proxies through the admin worker binding', async () => {
    const admin = {
      fetch: async (url: string, init?: RequestInit) => {
        expect(url).toBe('https://admin.freeappstore.online/api/creators');
        expect(init?.headers).toEqual({ 'X-Internal-Token': 'token-1' });
        return Response.json([{ github: 'alice', apps: [], banned: false, maxApps: 3 }]);
      },
    } as Fetcher;
    const res = await app.request(
      '/v1/admin/creators',
      {
        headers: { Authorization: await adminHeader() },
      },
      env(fakeDB({ user: adminUser }), { ADMIN: admin, ADMIN_PROVISION_TOKEN: 'token-1' }),
    );
    expect(res.status).toBe(200);
    const data = (await res.json()) as Array<{ github: string }>;
    expect(data[0]!.github).toBe('alice');
  });

  it('GET /v1/admin/creators reports missing admin worker setup', async () => {
    const res = await app.request(
      '/v1/admin/creators',
      {
        headers: { Authorization: await adminHeader() },
      },
      env(fakeDB({ user: adminUser })),
    );
    expect(res.status).toBe(503);
    const data = (await res.json()) as { error: string };
    expect(data.error).toContain('Admin worker binding');
  });
});

// ── Session debugging console against real SQL (#15) ─────────────
// The filters and malformed-JSON guards live in SQL, so these tests run the
// real endpoint queries on SQLite built from the real migrations, through a
// minimal D1 adapter.

// The backend typechecks as a Worker, without Node's types, so the two Node
// modules this harness needs are imported dynamically and typed by hand.
interface SqliteStatement {
  all(...binds: unknown[]): unknown[];
  get(...binds: unknown[]): unknown;
  run(...binds: unknown[]): unknown;
}
interface SqliteModule {
  DatabaseSync: new (
    path: string,
  ) => { exec(sql: string): void; prepare(sql: string): SqliteStatement };
}
interface FsModule {
  readdirSync(dir: URL): string[];
  readFileSync(file: URL, encoding: 'utf8'): string;
}
const nodeModule = <T>(name: string) => import(/* @vite-ignore */ name) as Promise<T>;
const sqlite = await nodeModule<SqliteModule>('node:sqlite').catch(() => null);
const fs = await nodeModule<FsModule>('node:fs');
const MIGRATIONS = new URL('../../migrations/', (import.meta as unknown as { url: string }).url);

function realDB() {
  if (!sqlite) throw new Error('node:sqlite unavailable');
  const db = new sqlite.DatabaseSync(':memory:');
  for (const f of fs
    .readdirSync(MIGRATIONS)
    .filter((name) => name.endsWith('.sql'))
    .sort()) {
    db.exec(fs.readFileSync(new URL(f, MIGRATIONS), 'utf8'));
  }
  const d1 = {
    prepare(sql: string) {
      let binds: unknown[] = [];
      const stmt = {
        bind(...args: unknown[]) {
          binds = args;
          return stmt;
        },
        async all() {
          return { results: db.prepare(sql).all(...binds) };
        },
        async first() {
          return db.prepare(sql).get(...binds) ?? null;
        },
        async run() {
          db.prepare(sql).run(...binds);
          return { meta: { changes: 1 } };
        },
      };
      return stmt;
    },
  } as unknown as D1Database;
  return { db, d1 };
}

describe.skipIf(!sqlite)('admin session debugging console (#15)', () => {
  const HOUR = 60 * 60 * 1000;
  const LONG_ERROR = `Build failed at build › Build web: src/App.tsx(3,7): error TS2322: ${'x'.repeat(150)}`;

  function seeded() {
    const { db, d1 } = realDB();
    const now = Date.now();
    const user = db.prepare(
      'INSERT INTO users (id, github_id, github_login, avatar_url, created_at, display_name) VALUES (?, ?, ?, NULL, ?, ?)',
    );
    user.run('gh:1', 1, 'alice', now, 'Alice Adams');
    user.run('gh:2', 2, 'bob', now, null);
    user.run('gh:99', 99, 'ops', now, null);
    const app = db.prepare(
      'INSERT INTO apps (id, owner_login, created_at, repo) VALUES (?, ?, ?, ?)',
    );
    app.run('dict', 'alice', now, 'freeappstore-online/dict');
    app.run('timer', 'bob', now, null);
    app.run('notes', 'bob', now, 'someorg/notes');
    const session = db.prepare(
      `INSERT INTO agent_sessions (session_id, user_id, name, app_id, app_url, deployed, deploy_state, errors, ai_source, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    const json = (v: unknown) => JSON.stringify(v);
    // Deployed, then an update's build failed; recent; grant-funded.
    session.run(
      's-fail',
      'gh:1',
      'Dictionary',
      'dict',
      'https://dict.freeappstore.online',
      1,
      json({ phase: 'error', error: 'build broke' }),
      json([{ message: 'old failure' }, { message: LONG_ERROR }]),
      'grant',
      now,
      now - HOUR,
    );
    // Live, clean, 3 days old.
    session.run(
      's-live',
      'gh:2',
      'Timer',
      'timer',
      'https://timer.freeappstore.online',
      1,
      json({ phase: 'live', appUrl: 'x' }),
      json([]),
      'vault_user',
      now,
      now - 72 * HOUR,
    );
    // Never deployed, recent.
    session.run('s-draft', 'gh:1', 'New App', null, null, 0, null, null, null, now, now - 2 * HOUR);
    // Never deployed, recent, and both debug columns are malformed JSON.
    session.run(
      's-bad',
      'gh:2',
      'under_score',
      null,
      null,
      0,
      '{not json',
      '[{"message":"x"',
      null,
      now,
      now - HOUR / 2,
    );
    // Live but carrying an old error; 5 days old.
    session.run(
      's-stale',
      'gh:2',
      'Notes',
      'notes',
      'https://notes.freeappstore.online',
      1,
      json({ phase: 'live' }),
      json([{ message: 'stale error' }]),
      'vault_admin',
      now,
      now - 120 * HOUR,
    );
    return d1;
  }

  async function sessions(d1: D1Database, query = '') {
    const token = await signSession('gh:99', SIGNING_KEY, { roles: ['admin'] });
    const res = await app.request(
      `https://backend/v1/admin/agent-sessions${query}`,
      { headers: { Authorization: `Bearer ${token}` } },
      { DB: d1, SESSION_SIGNING_KEY: SIGNING_KEY },
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { sessions: Array<Record<string, any>>; total: number };
    return { ...body, ids: body.sessions.map((s) => s.sessionId).sort() };
  }

  it('lists everything, including a row whose debug JSON is malformed', async () => {
    const { ids, total, sessions: rows } = await sessions(seeded());
    expect(ids).toEqual(['s-bad', 's-draft', 's-fail', 's-live', 's-stale']);
    expect(total).toBe(5);
    const bad = rows.find((r) => r.sessionId === 's-bad');
    expect(bad).toMatchObject({ deployState: null, errorCount: 0, lastErrorSummary: null });
  });

  it.each([
    ['?failed_deploy=true', ['s-fail']],
    ['?has_errors=true', ['s-fail', 's-stale']],
    ['?active_recently=true', ['s-bad', 's-draft', 's-fail']],
    ['?deployed=true', ['s-fail', 's-live', 's-stale']],
    ['?draft=true', ['s-bad', 's-draft']],
  ])('filter %s', async (query, expected) => {
    const { ids, total } = await sessions(seeded(), query);
    expect(ids).toEqual(expected);
    expect(total).toBe(expected.length); // counted server-side, not per page
  });

  it.each([
    ['?has_errors=true&active_recently=true', ['s-fail']],
    ['?deployed=true&has_errors=true', ['s-fail', 's-stale']],
    ['?failed_deploy=true&funded_by=grant', ['s-fail']],
    ['?has_errors=true&funded_by=admin_key', ['s-stale']],
    ['?draft=true&active_recently=true&q=under', ['s-bad']],
    ['?deployed=true&draft=true', []],
    ['?failed_deploy=false&has_errors=0', ['s-bad', 's-draft', 's-fail', 's-live', 's-stale']],
  ])('filters combine with AND: %s', async (query, expected) => {
    expect((await sessions(seeded(), query)).ids).toEqual(expected);
  });

  it('rows carry the last error (truncated), error count and repo link', async () => {
    const { sessions: rows } = await sessions(seeded());
    const byId = Object.fromEntries(rows.map((r) => [r.sessionId, r]));
    expect(byId['s-fail'].errorCount).toBe(2);
    expect(byId['s-fail'].lastErrorSummary).toHaveLength(120);
    expect(byId['s-fail'].lastErrorSummary).toMatch(/^Build failed at build › Build web: .*…$/);
    expect(byId['s-stale'].lastErrorSummary).toBe('stale error');
    expect(byId['s-fail'].repoUrl).toBe('https://github.com/freeappstore-online/dict');
    expect(byId['s-stale'].repoUrl).toBe('https://github.com/someorg/notes');
    expect(byId['s-live'].repoUrl).toBe('https://github.com/freeappstore-online/timer'); // no apps.repo: org default
    expect(byId['s-draft'].repoUrl).toBeNull();
  });

  it('search covers session ID, app ID, name, user ID, login and display name', async () => {
    const d1 = seeded();
    for (const [q, expected] of [
      ['s-live', ['s-live']],
      ['notes', ['s-stale']],
      ['Dictionary', ['s-fail']],
      ['gh:1', ['s-draft', 's-fail']],
      ['bob', ['s-bad', 's-live', 's-stale']],
      ['Alice Adams', ['s-draft', 's-fail']],
    ] as const) {
      expect((await sessions(d1, `?q=${encodeURIComponent(q)}`)).ids).toEqual(expected);
    }
  });

  it('search treats % and _ literally', async () => {
    const d1 = seeded();
    expect((await sessions(d1, `?q=${encodeURIComponent('under_score')}`)).ids).toEqual(['s-bad']);
    // Unescaped, "_" would match any character: "d_ct" would find "dict".
    expect((await sessions(d1, `?q=${encodeURIComponent('d_ct')}`)).ids).toEqual([]);
    expect((await sessions(d1, `?q=${encodeURIComponent('%')}`)).ids).toEqual([]);
  });

  it('the detail view tolerates malformed debug JSON and links the repo', async () => {
    const d1 = seeded();
    const token = await signSession('gh:99', SIGNING_KEY, { roles: ['admin'] });
    const get = (id: string) =>
      app.request(
        `https://backend/v1/admin/agent-sessions/${id}`,
        { headers: { Authorization: `Bearer ${token}` } },
        { DB: d1, SESSION_SIGNING_KEY: SIGNING_KEY },
      );

    const bad = await get('s-bad');
    expect(bad.status).toBe(200);
    expect(((await bad.json()) as any).session).toMatchObject({
      deployState: null,
      errors: [],
      repoUrl: null,
    });
    expect(((await (await get('s-fail')).json()) as any).session.repoUrl).toBe(
      'https://github.com/freeappstore-online/dict',
    );
  });

  it('the users list can show one user, for deep links', async () => {
    const token = await signSession('gh:99', SIGNING_KEY, { roles: ['admin'] });
    const res = await app.request(
      'https://backend/v1/admin/users?user=gh%3A2',
      { headers: { Authorization: `Bearer ${token}` } },
      { DB: seeded(), SESSION_SIGNING_KEY: SIGNING_KEY },
    );
    const body = (await res.json()) as { users: Array<{ id: string }>; total: number };
    expect(body.users.map((u) => u.id)).toEqual(['gh:2']);
    expect(body.total).toBe(1);
  });
});
