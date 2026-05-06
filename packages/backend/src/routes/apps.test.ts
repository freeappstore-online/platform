import { describe, it, expect } from 'vitest';
import { app } from '../index.js';
import type { Env } from '../types.js';
import { signSession } from '../lib/session.js';

interface AppRow {
  id: string;
  owner_login: string;
  created_at: number;
  category: string | null;
  type: string | null;
  oneliner: string | null;
  repo: string | null;
  demo: string | null;
}

interface UserRow {
  id: string;
  github_login: string;
  avatar_url: string | null;
}

const SIGNING_KEY = 'a'.repeat(64);

function fakeDB(rows: { apps?: AppRow[]; users?: UserRow[] } = {}): D1Database {
  const apps = rows.apps ?? [];
  const users = rows.users ?? [];
  return {
    prepare: (sql: string) => {
      const trimmed = sql.replace(/\s+/g, ' ').trim();
      let bound: unknown[] = [];
      const stmt: Partial<D1PreparedStatement> = {
        bind: (...args: unknown[]) => {
          bound = args;
          return stmt as D1PreparedStatement;
        },
        first: async <T>() => {
          if (trimmed.startsWith('SELECT id, github_login, avatar_url FROM users')) {
            const id = bound[0];
            const u = users.find((x) => x.id === id);
            return (u ?? null) as T | null;
          }
          return null as T | null;
        },
        all: async <T>() => {
          if (trimmed.startsWith('SELECT id, owner_login, created_at')) {
            const owner = bound[0];
            const matching = apps.filter((a) => a.owner_login === owner);
            return {
              results: matching as unknown as T[],
              success: true,
              meta: {},
            } as unknown as D1Result<T>;
          }
          return { results: [] as unknown as T[], success: true, meta: {} } as unknown as D1Result<T>;
        },
      };
      return stmt as D1PreparedStatement;
    },
  } as unknown as D1Database;
}

function baseEnv(db: D1Database): Env {
  return {
    DB: db,
    ROOM: {} as DurableObjectNamespace,
    GITHUB_CLIENT_ID: 'cid',
    GITHUB_CLIENT_SECRET: 'csec',
    SESSION_SIGNING_KEY: SIGNING_KEY,
  };
}

async function makeAuthHeader(uid = 'gh:1'): Promise<string> {
  const token = await signSession(uid, SIGNING_KEY);
  return `Bearer ${token}`;
}

describe('GET /v1/apps/mine', () => {
  it('401s when no Authorization header is sent', async () => {
    const res = await app.request('/v1/apps/mine', {}, baseEnv(fakeDB()));
    expect(res.status).toBe(401);
  });

  it('returns empty list when the user has no apps', async () => {
    const env = baseEnv(
      fakeDB({
        users: [{ id: 'gh:1', github_login: 'alice', avatar_url: null }],
        apps: [],
      }),
    );
    const res = await app.request(
      '/v1/apps/mine',
      { headers: { Authorization: await makeAuthHeader() } },
      env,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { apps: unknown[] };
    expect(body.apps).toEqual([]);
  });

  it('returns only apps owned by the authenticated user', async () => {
    const env = baseEnv(
      fakeDB({
        users: [{ id: 'gh:1', github_login: 'alice', avatar_url: null }],
        apps: [
          {
            id: 'tip',
            owner_login: 'alice',
            created_at: 1700000000000,
            category: 'Finance',
            type: 'standalone',
            oneliner: 'Tip calculator',
            repo: null,
            demo: null,
          },
          {
            id: 'counter',
            owner_login: 'alice',
            created_at: 1700000010000,
            category: 'Utilities',
            type: 'standalone',
            oneliner: 'Counter',
            repo: null,
            demo: null,
          },
          {
            id: 'someone-else',
            owner_login: 'bob',
            created_at: 1700000005000,
            category: 'Strategy',
            type: 'standalone',
            oneliner: 'Other',
            repo: null,
            demo: null,
          },
        ],
      }),
    );
    const res = await app.request(
      '/v1/apps/mine',
      { headers: { Authorization: await makeAuthHeader() } },
      env,
    );
    const body = (await res.json()) as { apps: { id: string; ownerLogin: string }[] };
    expect(body.apps).toHaveLength(2);
    expect(body.apps.every((a) => a.ownerLogin === 'alice')).toBe(true);
    const ids = body.apps.map((a) => a.id).sort();
    expect(ids).toEqual(['counter', 'tip']);
  });

  it('synthesizes appUrl + repoUrl in camelCase output shape', async () => {
    const env = baseEnv(
      fakeDB({
        users: [{ id: 'gh:1', github_login: 'alice', avatar_url: null }],
        apps: [
          {
            id: 'chess',
            owner_login: 'alice',
            created_at: 1700000000000,
            category: 'Strategy',
            type: 'connected',
            oneliner: 'Two-player chess',
            repo: 'https://github.com/alice/chess',
            demo: 'https://demo.chess.example',
          },
        ],
      }),
    );
    const res = await app.request(
      '/v1/apps/mine',
      { headers: { Authorization: await makeAuthHeader() } },
      env,
    );
    const body = (await res.json()) as {
      apps: Array<Record<string, unknown>>;
    };
    const a = body.apps[0]!;
    expect(a['id']).toBe('chess');
    expect(a['appUrl']).toBe('https://chess.freeappstore.online');
    expect(a['repoUrl']).toBe('https://github.com/alice/chess');
    // Snake_case fields must NOT leak through.
    expect(a['owner_login']).toBeUndefined();
    expect(a['created_at']).toBeUndefined();
    // Aliased fields ARE present.
    expect(a['ownerLogin']).toBe('alice');
    expect(a['createdAt']).toBe(1700000000000);
  });

  it('falls back to canonical org repoUrl when repo is null', async () => {
    const env = baseEnv(
      fakeDB({
        users: [{ id: 'gh:1', github_login: 'alice', avatar_url: null }],
        apps: [
          {
            id: 'tip',
            owner_login: 'alice',
            created_at: 1700000000000,
            category: 'Finance',
            type: 'standalone',
            oneliner: 'tip',
            repo: null,
            demo: null,
          },
        ],
      }),
    );
    const res = await app.request(
      '/v1/apps/mine',
      { headers: { Authorization: await makeAuthHeader() } },
      env,
    );
    const body = (await res.json()) as { apps: Array<{ repoUrl: string }> };
    expect(body.apps[0]!.repoUrl).toBe('https://github.com/freeappstore-online/tip');
  });
});

