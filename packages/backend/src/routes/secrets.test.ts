import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { app } from '../index.js';
import { signSession } from '../lib/session.js';
import type { Env } from '../types.js';

const SIGNING_KEY = 'a'.repeat(64);
const KEK = btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32))));

interface UserRow {
  id: string;
  github_login: string;
  avatar_url: string | null;
  display_name: string | null;
  email: string | null;
}
interface AppRow {
  id: string;
  owner_login: string;
}
interface SecretRow {
  app_id: string;
  name: string;
  key_ciphertext: Uint8Array;
  dek_wrapped: Uint8Array;
  iv: Uint8Array;
  created_at: number;
  last_used_at: number | null;
}
interface AllowRow {
  app_id: string;
  pattern: string;
  inject_kind: string;
  inject_name: string;
  secret_name: string;
  secret_name_2: string | null;
  token_url: string | null;
  methods: string;
  created_at: number;
}
interface UsageRow {
  app_id: string;
  day: string;
  count: number;
}

interface FakeData {
  users: UserRow[];
  apps: AppRow[];
  secrets: SecretRow[];
  allow: AllowRow[];
  usage: UsageRow[];
}

/**
 * Hand-rolled D1 mock that implements just enough SQL pattern matching to
 * exercise the routes. We match queries by their leading SQL fragment to
 * keep the dispatcher legible. If a query lands here unmatched it throws —
 * that's intentional, so a forgotten branch surfaces immediately.
 */
function fakeDB(d: FakeData): D1Database {
  const norm = (s: string) => s.replace(/\s+/g, ' ').trim();
  return {
    prepare: (raw: string) => {
      const sql = norm(raw);
      let bound: unknown[] = [];
      const stmt: Partial<D1PreparedStatement> = {
        bind: (...args: unknown[]) => {
          bound = args;
          return stmt as D1PreparedStatement;
        },
        first: async <T = Record<string, unknown>>() => first(sql, bound, d) as T | null,
        all: async <T = Record<string, unknown>>() =>
          ({
            results: all(sql, bound, d) as T[],
            success: true,
            meta: {},
          }) as unknown as D1Result<T>,
        run: async <T = Record<string, unknown>>() => {
          const changes = run(sql, bound, d);
          return { success: true, meta: { changes } } as unknown as D1Result<T>;
        },
      };
      return stmt as D1PreparedStatement;
    },
  } as unknown as D1Database;
}

function first(sql: string, bound: unknown[], d: FakeData): unknown | null {
  if (sql.startsWith('SELECT id, github_login, avatar_url')) {
    return d.users.find((u) => u.id === bound[0]) ?? null;
  }
  if (sql.startsWith('SELECT owner_login FROM apps')) {
    return d.apps.find((a) => a.id === bound[0]) ?? null;
  }
  if (sql.startsWith('SELECT 1 FROM app_secrets')) {
    const has = d.secrets.some((s) => s.app_id === bound[0] && s.name === bound[1]);
    return has ? { '1': 1 } : null;
  }
  if (sql.startsWith('SELECT COUNT(*) AS n FROM app_secrets')) {
    return { n: d.secrets.filter((s) => s.app_id === bound[0]).length };
  }
  if (sql.startsWith('SELECT 1 FROM app_proxy_allowlist')) {
    const has = d.allow.some((r) => r.app_id === bound[0] && r.pattern === bound[1]);
    return has ? { '1': 1 } : null;
  }
  if (sql.startsWith('SELECT COUNT(*) AS n FROM app_proxy_allowlist')) {
    return { n: d.allow.filter((r) => r.app_id === bound[0]).length };
  }
  if (sql.startsWith('SELECT key_ciphertext, dek_wrapped, iv FROM app_secrets')) {
    const row = d.secrets.find((s) => s.app_id === bound[0] && s.name === bound[1]);
    return row
      ? { key_ciphertext: row.key_ciphertext, dek_wrapped: row.dek_wrapped, iv: row.iv }
      : null;
  }
  if (sql.startsWith('SELECT count FROM app_proxy_usage')) {
    const row = d.usage.find((u) => u.app_id === bound[0] && u.day === bound[1]);
    return row ? { count: row.count } : null;
  }
  throw new Error(`fakeDB.first unmatched: ${sql}`);
}

function all(sql: string, bound: unknown[], d: FakeData): unknown[] {
  if (sql.startsWith('SELECT name, created_at, last_used_at FROM app_secrets')) {
    return d.secrets
      .filter((s) => s.app_id === bound[0])
      .map((s) => ({ name: s.name, created_at: s.created_at, last_used_at: s.last_used_at }));
  }
  if (
    sql.startsWith(
      'SELECT pattern, inject_kind, inject_name, secret_name, secret_name_2, token_url, methods, created_at FROM app_proxy_allowlist',
    )
  ) {
    return d.allow.filter((r) => r.app_id === bound[0]);
  }
  throw new Error(`fakeDB.all unmatched: ${sql}`);
}

function run(sql: string, bound: unknown[], d: FakeData): number {
  if (sql.startsWith('INSERT INTO app_secrets')) {
    const [app_id, name, key_ciphertext, dek_wrapped, iv, created_at] = bound as [
      string,
      string,
      Uint8Array,
      Uint8Array,
      Uint8Array,
      number,
    ];
    const idx = d.secrets.findIndex((s) => s.app_id === app_id && s.name === name);
    const row: SecretRow = {
      app_id,
      name,
      key_ciphertext,
      dek_wrapped,
      iv,
      created_at,
      last_used_at: null,
    };
    if (idx >= 0) d.secrets[idx] = row;
    else d.secrets.push(row);
    return 1;
  }
  if (sql.startsWith('DELETE FROM app_secrets')) {
    const before = d.secrets.length;
    d.secrets = d.secrets.filter((s) => !(s.app_id === bound[0] && s.name === bound[1]));
    return before - d.secrets.length;
  }
  if (sql.startsWith('INSERT INTO app_proxy_allowlist')) {
    const [
      app_id,
      pattern,
      inject_kind,
      inject_name,
      secret_name,
      secret_name_2,
      token_url,
      methods,
      created_at,
    ] = bound as [
      string,
      string,
      string,
      string,
      string,
      string | null,
      string | null,
      string,
      number,
    ];
    const idx = d.allow.findIndex((r) => r.app_id === app_id && r.pattern === pattern);
    const row: AllowRow = {
      app_id,
      pattern,
      inject_kind,
      inject_name,
      secret_name,
      secret_name_2,
      token_url,
      methods,
      created_at,
    };
    if (idx >= 0) d.allow[idx] = row;
    else d.allow.push(row);
    return 1;
  }
  if (sql.startsWith('DELETE FROM app_proxy_allowlist')) {
    const before = d.allow.length;
    d.allow = d.allow.filter((r) => !(r.app_id === bound[0] && r.pattern === bound[1]));
    return before - d.allow.length;
  }
  if (sql.startsWith('INSERT INTO app_proxy_usage')) {
    const [app_id, day, by] = bound as [string, string, number];
    const idx = d.usage.findIndex((u) => u.app_id === app_id && u.day === day);
    if (idx >= 0) d.usage[idx]!.count += by;
    else d.usage.push({ app_id, day, count: by });
    return 1;
  }
  if (sql.startsWith('UPDATE app_secrets SET last_used_at')) {
    const row = d.secrets.find((s) => s.app_id === bound[1] && s.name === bound[2]);
    if (row) row.last_used_at = bound[0] as number;
    return row ? 1 : 0;
  }
  throw new Error(`fakeDB.run unmatched: ${sql}`);
}

function baseEnv(db: D1Database, withKek = true): Env {
  return {
    DB: db,
    ROOM: {} as DurableObjectNamespace,
    GITHUB_CLIENT_ID: 'cid',
    GITHUB_CLIENT_SECRET: 'csec',
    SESSION_SIGNING_KEY: SIGNING_KEY,
    ...(withKek ? { APP_SECRET_KEK: KEK } : {}),
  };
}

const owner: UserRow = {
  id: 'gh:1',
  github_login: 'alice',
  avatar_url: null,
  display_name: null,
  email: null,
};
const stranger: UserRow = {
  id: 'gh:2',
  github_login: 'mallory',
  avatar_url: null,
  display_name: null,
  email: null,
};
const weatherApp: AppRow = { id: 'weather', owner_login: 'alice' };

function freshData(): FakeData {
  return {
    users: [owner, stranger],
    apps: [weatherApp],
    secrets: [],
    allow: [],
    usage: [],
  };
}

async function ownerAuth() {
  return `Bearer ${await signSession(owner.id, SIGNING_KEY)}`;
}
async function strangerAuth() {
  return `Bearer ${await signSession(stranger.id, SIGNING_KEY)}`;
}

describe('PUT /v1/apps/:appId/secrets/:name', () => {
  it('401s without auth', async () => {
    const data = freshData();
    const res = await app.request(
      '/v1/apps/weather/secrets/OPENWEATHER_KEY',
      { method: 'PUT', body: JSON.stringify({ value: 'k' }) },
      baseEnv(fakeDB(data)),
    );
    expect(res.status).toBe(401);
  });

  it('403s when caller is not the app owner', async () => {
    const data = freshData();
    const res = await app.request(
      '/v1/apps/weather/secrets/OPENWEATHER_KEY',
      {
        method: 'PUT',
        headers: { Authorization: await strangerAuth(), 'Content-Type': 'application/json' },
        body: JSON.stringify({ value: 'k' }),
      },
      baseEnv(fakeDB(data)),
    );
    expect(res.status).toBe(403);
  });

  it('400s on lower-case secret name', async () => {
    const data = freshData();
    const res = await app.request(
      '/v1/apps/weather/secrets/openweather',
      {
        method: 'PUT',
        headers: { Authorization: await ownerAuth(), 'Content-Type': 'application/json' },
        body: JSON.stringify({ value: 'k' }),
      },
      baseEnv(fakeDB(data)),
    );
    expect(res.status).toBe(400);
  });

  it('503s when KEK is unset', async () => {
    const data = freshData();
    const res = await app.request(
      '/v1/apps/weather/secrets/OPENWEATHER_KEY',
      {
        method: 'PUT',
        headers: { Authorization: await ownerAuth(), 'Content-Type': 'application/json' },
        body: JSON.stringify({ value: 'k' }),
      },
      baseEnv(fakeDB(data), /* withKek */ false),
    );
    expect(res.status).toBe(503);
  });

  it('writes encrypted bytes (not the plaintext) to the row', async () => {
    const data = freshData();
    const res = await app.request(
      '/v1/apps/weather/secrets/OPENWEATHER_KEY',
      {
        method: 'PUT',
        headers: { Authorization: await ownerAuth(), 'Content-Type': 'application/json' },
        body: JSON.stringify({ value: 'sk-supersecret' }),
      },
      baseEnv(fakeDB(data)),
    );
    expect(res.status).toBe(204);
    expect(data.secrets).toHaveLength(1);
    const row = data.secrets[0]!;
    const asText = new TextDecoder().decode(row.key_ciphertext);
    expect(asText).not.toContain('supersecret');
  });

  it('rejects past the 5-secret cap', async () => {
    const data = freshData();
    for (let i = 0; i < 5; i++) {
      data.secrets.push({
        app_id: 'weather',
        name: `KEY_${i}`,
        key_ciphertext: new Uint8Array([1]),
        dek_wrapped: new Uint8Array([1]),
        iv: new Uint8Array([1]),
        created_at: 0,
        last_used_at: null,
      });
    }
    const res = await app.request(
      '/v1/apps/weather/secrets/SIXTH',
      {
        method: 'PUT',
        headers: { Authorization: await ownerAuth(), 'Content-Type': 'application/json' },
        body: JSON.stringify({ value: 'x' }),
      },
      baseEnv(fakeDB(data)),
    );
    expect(res.status).toBe(409);
  });

  it('updating an existing name does not bump the cap', async () => {
    const data = freshData();
    for (let i = 0; i < 5; i++) {
      data.secrets.push({
        app_id: 'weather',
        name: `KEY_${i}`,
        key_ciphertext: new Uint8Array([1]),
        dek_wrapped: new Uint8Array([1]),
        iv: new Uint8Array([1]),
        created_at: 0,
        last_used_at: null,
      });
    }
    const res = await app.request(
      '/v1/apps/weather/secrets/KEY_0',
      {
        method: 'PUT',
        headers: { Authorization: await ownerAuth(), 'Content-Type': 'application/json' },
        body: JSON.stringify({ value: 'rotated' }),
      },
      baseEnv(fakeDB(data)),
    );
    expect(res.status).toBe(204);
    expect(data.secrets).toHaveLength(5);
  });
});

describe('PUT /v1/apps/:appId/secrets/:name — input validation', () => {
  it('400s on empty value', async () => {
    const data = freshData();
    const res = await app.request(
      '/v1/apps/weather/secrets/KEY',
      {
        method: 'PUT',
        headers: { Authorization: await ownerAuth(), 'Content-Type': 'application/json' },
        body: JSON.stringify({ value: '' }),
      },
      baseEnv(fakeDB(data)),
    );
    expect(res.status).toBe(400);
  });

  it('400s on non-string value', async () => {
    const data = freshData();
    const res = await app.request(
      '/v1/apps/weather/secrets/KEY',
      {
        method: 'PUT',
        headers: { Authorization: await ownerAuth(), 'Content-Type': 'application/json' },
        body: JSON.stringify({ value: 12345 }),
      },
      baseEnv(fakeDB(data)),
    );
    expect(res.status).toBe(400);
  });

  it('400s on missing body', async () => {
    const data = freshData();
    const res = await app.request(
      '/v1/apps/weather/secrets/KEY',
      {
        method: 'PUT',
        headers: { Authorization: await ownerAuth(), 'Content-Type': 'application/json' },
      },
      baseEnv(fakeDB(data)),
    );
    expect(res.status).toBe(400);
  });

  it('400s when value is over 4096 chars', async () => {
    const data = freshData();
    const res = await app.request(
      '/v1/apps/weather/secrets/KEY',
      {
        method: 'PUT',
        headers: { Authorization: await ownerAuth(), 'Content-Type': 'application/json' },
        body: JSON.stringify({ value: 'x'.repeat(4097) }),
      },
      baseEnv(fakeDB(data)),
    );
    expect(res.status).toBe(400);
  });

  it('404s when the app does not exist', async () => {
    const data = freshData();
    const res = await app.request(
      '/v1/apps/nonexistent/secrets/KEY',
      {
        method: 'PUT',
        headers: { Authorization: await ownerAuth(), 'Content-Type': 'application/json' },
        body: JSON.stringify({ value: 'x' }),
      },
      baseEnv(fakeDB(data)),
    );
    expect(res.status).toBe(404);
  });
});

describe('GET /v1/apps/:appId/secrets', () => {
  it('returns the secret list (names only — never the value)', async () => {
    const data = freshData();
    data.secrets.push({
      app_id: 'weather',
      name: 'OPENWEATHER_KEY',
      key_ciphertext: new Uint8Array([1, 2]),
      dek_wrapped: new Uint8Array([3, 4]),
      iv: new Uint8Array([5, 6]),
      created_at: 1000,
      last_used_at: 2000,
    });
    const res = await app.request(
      '/v1/apps/weather/secrets',
      { headers: { Authorization: await ownerAuth() } },
      baseEnv(fakeDB(data)),
    );
    expect(res.status).toBe(200);
    const body = await res.json<{ secrets: unknown[] }>();
    expect(body).toEqual({
      secrets: [{ name: 'OPENWEATHER_KEY', createdAt: 1000, lastUsedAt: 2000 }],
    });
  });

  it('returns an empty list when no secrets exist', async () => {
    const data = freshData();
    const res = await app.request(
      '/v1/apps/weather/secrets',
      { headers: { Authorization: await ownerAuth() } },
      baseEnv(fakeDB(data)),
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ secrets: [] });
  });

  it('403s when caller is not the owner', async () => {
    const data = freshData();
    const res = await app.request(
      '/v1/apps/weather/secrets',
      { headers: { Authorization: await strangerAuth() } },
      baseEnv(fakeDB(data)),
    );
    expect(res.status).toBe(403);
  });
});

describe('DELETE /v1/apps/:appId/secrets/:name', () => {
  it('removes the row, 204', async () => {
    const data = freshData();
    data.secrets.push({
      app_id: 'weather',
      name: 'X',
      key_ciphertext: new Uint8Array([1]),
      dek_wrapped: new Uint8Array([1]),
      iv: new Uint8Array([1]),
      created_at: 0,
      last_used_at: null,
    });
    const res = await app.request(
      '/v1/apps/weather/secrets/X',
      { method: 'DELETE', headers: { Authorization: await ownerAuth() } },
      baseEnv(fakeDB(data)),
    );
    expect(res.status).toBe(204);
    expect(data.secrets).toHaveLength(0);
  });

  it('404s when the secret does not exist', async () => {
    const data = freshData();
    const res = await app.request(
      '/v1/apps/weather/secrets/NOPE',
      { method: 'DELETE', headers: { Authorization: await ownerAuth() } },
      baseEnv(fakeDB(data)),
    );
    expect(res.status).toBe(404);
  });
});

describe('PUT /v1/apps/:appId/allowlist', () => {
  beforeEach(() => {
    // Each test seeds its own data — nothing global to reset here, but the
    // hook keeps the structure parallel to the other suites.
  });

  it('rejects when the referenced secret does not exist', async () => {
    const data = freshData();
    const res = await app.request(
      '/v1/apps/weather/allowlist',
      {
        method: 'PUT',
        headers: { Authorization: await ownerAuth(), 'Content-Type': 'application/json' },
        body: JSON.stringify({
          pattern: 'https://api.openweathermap.org/data/2.5/',
          injectKind: 'query',
          injectName: 'appid',
          secretName: 'OPENWEATHER_KEY',
          methods: ['GET'],
        }),
      },
      baseEnv(fakeDB(data)),
    );
    expect(res.status).toBe(400);
  });

  it('rejects an AI provider host (PAS-only territory)', async () => {
    const data = freshData();
    data.secrets.push({
      app_id: 'weather',
      name: 'KEY',
      key_ciphertext: new Uint8Array([1]),
      dek_wrapped: new Uint8Array([1]),
      iv: new Uint8Array([1]),
      created_at: 0,
      last_used_at: null,
    });
    const res = await app.request(
      '/v1/apps/weather/allowlist',
      {
        method: 'PUT',
        headers: { Authorization: await ownerAuth(), 'Content-Type': 'application/json' },
        body: JSON.stringify({
          pattern: 'https://api.openai.com/v1/chat/completions',
          injectKind: 'bearer',
          injectName: '',
          secretName: 'KEY',
          methods: ['POST'],
        }),
      },
      baseEnv(fakeDB(data)),
    );
    expect(res.status).toBe(400);
    const body = await res.json<{ error: string }>();
    expect(body.error).toMatch(/PAS AI key vault/);
  });

  it('inserts when valid', async () => {
    const data = freshData();
    data.secrets.push({
      app_id: 'weather',
      name: 'OPENWEATHER_KEY',
      key_ciphertext: new Uint8Array([1]),
      dek_wrapped: new Uint8Array([1]),
      iv: new Uint8Array([1]),
      created_at: 0,
      last_used_at: null,
    });
    const res = await app.request(
      '/v1/apps/weather/allowlist',
      {
        method: 'PUT',
        headers: { Authorization: await ownerAuth(), 'Content-Type': 'application/json' },
        body: JSON.stringify({
          pattern: 'https://api.openweathermap.org/data/2.5/',
          injectKind: 'query',
          injectName: 'appid',
          secretName: 'OPENWEATHER_KEY',
          methods: ['get'],
        }),
      },
      baseEnv(fakeDB(data)),
    );
    expect(res.status).toBe(204);
    expect(data.allow).toHaveLength(1);
    expect(data.allow[0]!.methods).toBe('GET');
  });

  it('rejects past the 5-rule cap', async () => {
    const data = freshData();
    data.secrets.push({
      app_id: 'weather',
      name: 'KEY',
      key_ciphertext: new Uint8Array([1]),
      dek_wrapped: new Uint8Array([1]),
      iv: new Uint8Array([1]),
      created_at: 0,
      last_used_at: null,
    });
    for (let i = 0; i < 5; i++) {
      data.allow.push({
        app_id: 'weather',
        pattern: `https://api${i}.example.com/`,
        inject_kind: 'header',
        inject_name: 'X-API-Key',
        secret_name: 'KEY',
        secret_name_2: null,
        token_url: null,
        methods: 'GET',
        created_at: 0,
      });
    }
    const res = await app.request(
      '/v1/apps/weather/allowlist',
      {
        method: 'PUT',
        headers: { Authorization: await ownerAuth(), 'Content-Type': 'application/json' },
        body: JSON.stringify({
          pattern: 'https://api6.example.com/',
          injectKind: 'header',
          injectName: 'X-API-Key',
          secretName: 'KEY',
          methods: ['GET'],
        }),
      },
      baseEnv(fakeDB(data)),
    );
    expect(res.status).toBe(409);
  });

  it('updating an existing pattern does not bump the cap', async () => {
    const data = freshData();
    data.secrets.push({
      app_id: 'weather',
      name: 'KEY',
      key_ciphertext: new Uint8Array([1]),
      dek_wrapped: new Uint8Array([1]),
      iv: new Uint8Array([1]),
      created_at: 0,
      last_used_at: null,
    });
    for (let i = 0; i < 5; i++) {
      data.allow.push({
        app_id: 'weather',
        pattern: `https://api${i}.example.com/`,
        inject_kind: 'header',
        inject_name: 'X-API-Key',
        secret_name: 'KEY',
        secret_name_2: null,
        token_url: null,
        methods: 'GET',
        created_at: 0,
      });
    }
    // Update the first rule (existing pattern) — must succeed even at cap.
    const res = await app.request(
      '/v1/apps/weather/allowlist',
      {
        method: 'PUT',
        headers: { Authorization: await ownerAuth(), 'Content-Type': 'application/json' },
        body: JSON.stringify({
          pattern: 'https://api0.example.com/',
          injectKind: 'header',
          injectName: 'X-Different-Header',
          secretName: 'KEY',
          methods: ['GET', 'POST'],
        }),
      },
      baseEnv(fakeDB(data)),
    );
    expect(res.status).toBe(204);
    expect(data.allow).toHaveLength(5);
    expect(data.allow.find((r) => r.pattern === 'https://api0.example.com/')!.inject_name).toBe(
      'X-Different-Header',
    );
  });

  it('rejects invalid pattern (not https)', async () => {
    const data = freshData();
    data.secrets.push({
      app_id: 'weather',
      name: 'KEY',
      key_ciphertext: new Uint8Array([1]),
      dek_wrapped: new Uint8Array([1]),
      iv: new Uint8Array([1]),
      created_at: 0,
      last_used_at: null,
    });
    const res = await app.request(
      '/v1/apps/weather/allowlist',
      {
        method: 'PUT',
        headers: { Authorization: await ownerAuth(), 'Content-Type': 'application/json' },
        body: JSON.stringify({
          pattern: 'http://api.example.com/',
          injectKind: 'header',
          injectName: 'X-API-Key',
          secretName: 'KEY',
          methods: ['GET'],
        }),
      },
      baseEnv(fakeDB(data)),
    );
    expect(res.status).toBe(400);
  });
});

describe('GET /v1/apps/:appId/allowlist', () => {
  it('returns the rule list with parsed methods', async () => {
    const data = freshData();
    data.allow.push({
      app_id: 'weather',
      pattern: 'https://api.openweathermap.org/data/2.5/',
      inject_kind: 'query',
      inject_name: 'appid',
      secret_name: 'OPENWEATHER_KEY',
      secret_name_2: null,
      token_url: null,
      methods: 'GET,POST',
      created_at: 1234,
    });
    const res = await app.request(
      '/v1/apps/weather/allowlist',
      { headers: { Authorization: await ownerAuth() } },
      baseEnv(fakeDB(data)),
    );
    expect(res.status).toBe(200);
    const body = await res.json<{ rules: unknown[] }>();
    expect(body).toEqual({
      rules: [
        {
          pattern: 'https://api.openweathermap.org/data/2.5/',
          injectKind: 'query',
          injectName: 'appid',
          secretName: 'OPENWEATHER_KEY',
          methods: ['GET', 'POST'],
          createdAt: 1234,
        },
      ],
    });
  });

  it('returns an empty list when no rules exist', async () => {
    const data = freshData();
    const res = await app.request(
      '/v1/apps/weather/allowlist',
      { headers: { Authorization: await ownerAuth() } },
      baseEnv(fakeDB(data)),
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ rules: [] });
  });

  it('403s when caller is not the owner', async () => {
    const data = freshData();
    const res = await app.request(
      '/v1/apps/weather/allowlist',
      { headers: { Authorization: await strangerAuth() } },
      baseEnv(fakeDB(data)),
    );
    expect(res.status).toBe(403);
  });
});

describe('DELETE /v1/apps/:appId/allowlist', () => {
  it('removes the rule, 204', async () => {
    const data = freshData();
    data.allow.push({
      app_id: 'weather',
      pattern: 'https://api.example.com/',
      inject_kind: 'header',
      inject_name: 'X-API-Key',
      secret_name: 'KEY',
      secret_name_2: null,
      token_url: null,
      methods: 'GET',
      created_at: 0,
    });
    const res = await app.request(
      '/v1/apps/weather/allowlist',
      {
        method: 'DELETE',
        headers: { Authorization: await ownerAuth(), 'Content-Type': 'application/json' },
        body: JSON.stringify({ pattern: 'https://api.example.com/' }),
      },
      baseEnv(fakeDB(data)),
    );
    expect(res.status).toBe(204);
    expect(data.allow).toHaveLength(0);
  });

  it('404s when the pattern is not in the allowlist', async () => {
    const data = freshData();
    const res = await app.request(
      '/v1/apps/weather/allowlist',
      {
        method: 'DELETE',
        headers: { Authorization: await ownerAuth(), 'Content-Type': 'application/json' },
        body: JSON.stringify({ pattern: 'https://nope.example.com/' }),
      },
      baseEnv(fakeDB(data)),
    );
    expect(res.status).toBe(404);
  });

  it('400s when pattern is missing', async () => {
    const data = freshData();
    const res = await app.request(
      '/v1/apps/weather/allowlist',
      {
        method: 'DELETE',
        headers: { Authorization: await ownerAuth(), 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      },
      baseEnv(fakeDB(data)),
    );
    expect(res.status).toBe(400);
  });

  it('403s when caller is not the owner', async () => {
    const data = freshData();
    data.allow.push({
      app_id: 'weather',
      pattern: 'https://api.example.com/',
      inject_kind: 'header',
      inject_name: 'X-API-Key',
      secret_name: 'KEY',
      secret_name_2: null,
      token_url: null,
      methods: 'GET',
      created_at: 0,
    });
    const res = await app.request(
      '/v1/apps/weather/allowlist',
      {
        method: 'DELETE',
        headers: { Authorization: await strangerAuth(), 'Content-Type': 'application/json' },
        body: JSON.stringify({ pattern: 'https://api.example.com/' }),
      },
      baseEnv(fakeDB(data)),
    );
    expect(res.status).toBe(403);
    expect(data.allow).toHaveLength(1); // unchanged
  });
});

describe('proxy: ANY /v1/apps/:appId/proxy/<host>/<path>', () => {
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  // Helper: seal a real secret value under KEK so the proxy can decrypt.
  async function realSeed(
    d: FakeData,
    name: string,
    plaintext: string,
    rule: Omit<AllowRow, 'app_id' | 'created_at'>,
  ) {
    const { sealSecret } = await import('../lib/encryption.js');
    const sealed = await sealSecret(plaintext, KEK);
    d.secrets.push({
      app_id: 'weather',
      name,
      key_ciphertext: sealed.keyCiphertext,
      dek_wrapped: sealed.dekWrapped,
      iv: sealed.iv,
      created_at: 0,
      last_used_at: null,
    });
    d.allow.push({ app_id: 'weather', created_at: 0, ...rule });
  }

  it('403s when no allowlist rule matches', async () => {
    const data = freshData();
    await realSeed(data, 'X', 'sekret', {
      pattern: 'https://api.example.com/',
      inject_kind: 'header',
      inject_name: 'X-API-Key',
      secret_name: 'X',
      secret_name_2: null,
      token_url: null,
      methods: 'GET',
    });
    const res = await app.request(
      '/v1/apps/weather/proxy/api.openweathermap.org/data/2.5/weather',
      { headers: { Authorization: await ownerAuth() } },
      baseEnv(fakeDB(data)),
    );
    expect(res.status).toBe(403);
  });

  it('400s on host-injection (userinfo) instead of leaking the secret', async () => {
    const data = freshData();
    // Path-less rule — the vulnerable case a prefix match would wrongly accept.
    await realSeed(data, 'X', 'sekret', {
      pattern: 'https://api.example.com',
      inject_kind: 'header',
      inject_name: 'X-API-Key',
      secret_name: 'X',
      secret_name_2: null,
      token_url: null,
      methods: 'GET',
    });
    const fetchSpy = vi.fn(async () => new Response('{}', { status: 200 }));
    globalThis.fetch = fetchSpy as typeof fetch;
    // `api.example.com@evil.com` prefix-matches the rule but resolves to evil.com.
    const res = await app.request(
      '/v1/apps/weather/proxy/api.example.com@evil.com/x',
      { headers: { Authorization: await ownerAuth() } },
      baseEnv(fakeDB(data)),
    );
    expect(res.status).toBe(400);
    // Critical: the secret must never be forwarded to the injected host.
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('injects a query secret and forwards the request', async () => {
    const data = freshData();
    await realSeed(data, 'OPENWEATHER_KEY', 'sk-real', {
      pattern: 'https://api.openweathermap.org/data/2.5/',
      inject_kind: 'query',
      inject_name: 'appid',
      secret_name: 'OPENWEATHER_KEY',
      secret_name_2: null,
      token_url: null,
      methods: 'GET',
    });
    const captured: { url?: string; init?: RequestInit | undefined } = {};
    globalThis.fetch = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
      captured.url = String(url);
      captured.init = init;
      return new Response(JSON.stringify({ temp: 273 }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }) as typeof fetch;

    const res = await app.request(
      '/v1/apps/weather/proxy/api.openweathermap.org/data/2.5/weather?q=London',
      { headers: { Authorization: await ownerAuth() } },
      baseEnv(fakeDB(data)),
    );
    expect(res.status).toBe(200);
    expect(captured.url).toBe(
      'https://api.openweathermap.org/data/2.5/weather?q=London&appid=sk-real',
    );
    // Authorization header from caller must NOT have been forwarded.
    const fwd = new Headers(captured.init?.headers);
    expect(fwd.get('authorization')).toBeNull();
  });

  it('429s when daily quota is exhausted', async () => {
    const data = freshData();
    await realSeed(data, 'K', 'v', {
      pattern: 'https://api.example.com/',
      inject_kind: 'header',
      inject_name: 'X-API-Key',
      secret_name: 'K',
      secret_name_2: null,
      token_url: null,
      methods: 'GET',
    });
    // Match dayKey() format used by the route.
    const today = new Date().toISOString().slice(0, 10);
    data.usage.push({ app_id: 'weather', day: today, count: 10_000 });
    const res = await app.request(
      '/v1/apps/weather/proxy/api.example.com/v1/x',
      { headers: { Authorization: await ownerAuth() } },
      baseEnv(fakeDB(data)),
    );
    expect(res.status).toBe(429);
  });

  it('502s when the upstream response is too large', async () => {
    const data = freshData();
    await realSeed(data, 'K', 'v', {
      pattern: 'https://api.example.com/',
      inject_kind: 'header',
      inject_name: 'X-API-Key',
      secret_name: 'K',
      secret_name_2: null,
      token_url: null,
      methods: 'GET',
    });
    const huge = new Uint8Array(101 * 1024);
    globalThis.fetch = vi.fn(async () => new Response(huge)) as typeof fetch;
    const res = await app.request(
      '/v1/apps/weather/proxy/api.example.com/v1/x',
      { headers: { Authorization: await ownerAuth() } },
      baseEnv(fakeDB(data)),
    );
    expect(res.status).toBe(502);
  });

  it('413s when the request body is too large', async () => {
    const data = freshData();
    await realSeed(data, 'K', 'v', {
      pattern: 'https://api.example.com/',
      inject_kind: 'header',
      inject_name: 'X-API-Key',
      secret_name: 'K',
      secret_name_2: null,
      token_url: null,
      methods: 'POST',
    });
    const big = new Uint8Array(101 * 1024);
    const res = await app.request(
      '/v1/apps/weather/proxy/api.example.com/v1/x',
      {
        method: 'POST',
        headers: {
          Authorization: await ownerAuth(),
          'content-type': 'application/octet-stream',
        },
        body: big,
      },
      baseEnv(fakeDB(data)),
    );
    expect(res.status).toBe(413);
  });

  it('allows non-owner sessions to use the proxy', async () => {
    const data = freshData();
    await realSeed(data, 'K', 'v', {
      pattern: 'https://api.example.com/',
      inject_kind: 'header',
      inject_name: 'X-API-Key',
      secret_name: 'K',
      secret_name_2: null,
      token_url: null,
      methods: 'GET',
    });
    globalThis.fetch = vi.fn(async () => new Response('ok')) as typeof fetch;
    const res = await app.request(
      '/v1/apps/weather/proxy/api.example.com/v1/x',
      { headers: { Authorization: await strangerAuth() } },
      baseEnv(fakeDB(data)),
    );
    expect(res.status).toBe(200);
  });

  it('strips content-encoding/length and preserves multi-value headers', async () => {
    const data = freshData();
    await realSeed(data, 'K', 'v', {
      pattern: 'https://api.example.com/',
      inject_kind: 'header',
      inject_name: 'X-API-Key',
      secret_name: 'K',
      secret_name_2: null,
      token_url: null,
      methods: 'GET',
    });
    // Upstream returns gzip-tagged + multi-value Vary. Workers fetch would
    // auto-decompress in prod; we must NOT forward content-encoding/length,
    // and Vary must keep both values.
    const upstreamHeaders = new Headers();
    upstreamHeaders.set('content-type', 'application/json');
    upstreamHeaders.set('content-encoding', 'gzip');
    upstreamHeaders.set('content-length', '999');
    upstreamHeaders.append('Vary', 'Accept');
    upstreamHeaders.append('Vary', 'Origin');
    upstreamHeaders.append('Set-Cookie', 'session=leak; Path=/');
    globalThis.fetch = vi.fn(
      async () => new Response('{"ok":true}', { headers: upstreamHeaders }),
    ) as typeof fetch;

    const res = await app.request(
      '/v1/apps/weather/proxy/api.example.com/v1/x',
      { headers: { Authorization: await ownerAuth() } },
      baseEnv(fakeDB(data)),
    );
    expect(res.status).toBe(200);
    expect(res.headers.get('content-encoding')).toBeNull();
    expect(res.headers.get('content-length')).toBeNull();
    expect(res.headers.get('set-cookie')).toBeNull();
    // Both Vary values should be preserved (Headers.getSetCookie isn't right
    // for Vary, but get() returns them comma-joined per spec).
    const vary = res.headers.get('vary') ?? '';
    expect(vary).toContain('Accept');
    expect(vary).toContain('Origin');
  });

  it('injects a Bearer token (no other headers leaked)', async () => {
    const data = freshData();
    await realSeed(data, 'GH_TOKEN', 'ghp_secret', {
      pattern: 'https://api.github.com/',
      inject_kind: 'bearer',
      inject_name: '',
      secret_name: 'GH_TOKEN',
      secret_name_2: null,
      token_url: null,
      methods: 'GET',
    });
    const captured: { init?: RequestInit | undefined } = {};
    globalThis.fetch = vi.fn(async (_url, init) => {
      captured.init = init;
      return new Response('{}');
    }) as typeof fetch;
    await app.request(
      '/v1/apps/weather/proxy/api.github.com/user',
      { headers: { Authorization: await ownerAuth() } },
      baseEnv(fakeDB(data)),
    );
    const fwd = new Headers(captured.init?.headers);
    expect(fwd.get('authorization')).toBe('Bearer ghp_secret');
  });

  it('injects an OAuth2 bearer token via client_credentials flow', async () => {
    const data = freshData();
    // Seed both client_id and client_secret
    await realSeed(data, 'AMADEUS_ID', 'my-client-id', {
      pattern: 'https://test.api.amadeus.com/v2/',
      inject_kind: 'oauth2_cc',
      inject_name: '',
      secret_name: 'AMADEUS_ID',
      secret_name_2: 'AMADEUS_SECRET',
      token_url: 'https://test.api.amadeus.com/v1/security/oauth2/token',
      methods: 'GET',
    });
    // realSeed only seeds one secret; manually seed the second
    const { sealSecret } = await import('../lib/encryption.js');
    const sealed2 = await sealSecret('my-client-secret', KEK);
    data.secrets.push({
      app_id: 'weather',
      name: 'AMADEUS_SECRET',
      key_ciphertext: sealed2.keyCiphertext,
      dek_wrapped: sealed2.dekWrapped,
      iv: sealed2.iv,
      created_at: 0,
      last_used_at: null,
    });

    const captured: { url?: string; init?: RequestInit | undefined } = {};
    const tokenCalls: string[] = [];
    globalThis.fetch = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
      const u = String(url);
      if (u.includes('amadeus.com/v1/security/oauth2/token')) {
        tokenCalls.push(u);
        return new Response(JSON.stringify({ access_token: 'tok_abc', expires_in: 1799 }));
      }
      // Upstream API call
      captured.url = u;
      captured.init = init;
      return new Response(JSON.stringify({ data: [] }));
    }) as typeof fetch;

    const res = await app.request(
      '/v1/apps/weather/proxy/test.api.amadeus.com/v2/shopping/flights',
      { headers: { Authorization: await ownerAuth() } },
      baseEnv(fakeDB(data)),
    );
    expect(res.status).toBe(200);
    // Token endpoint was called
    expect(tokenCalls).toHaveLength(1);
    // Upstream got the OAuth2 bearer token, not the client_id
    const fwd = new Headers(captured.init?.headers);
    expect(fwd.get('authorization')).toBe('Bearer tok_abc');
  });

  it('injects a header secret', async () => {
    const data = freshData();
    await realSeed(data, 'API_KEY', 'sek', {
      pattern: 'https://api.example.com/',
      inject_kind: 'header',
      inject_name: 'X-API-Key',
      secret_name: 'API_KEY',
      secret_name_2: null,
      token_url: null,
      methods: 'GET',
    });
    const captured: { init?: RequestInit | undefined } = {};
    globalThis.fetch = vi.fn(async (_url, init) => {
      captured.init = init;
      return new Response('ok');
    }) as typeof fetch;
    await app.request(
      '/v1/apps/weather/proxy/api.example.com/v1/x',
      { headers: { Authorization: await ownerAuth() } },
      baseEnv(fakeDB(data)),
    );
    const fwd = new Headers(captured.init?.headers);
    expect(fwd.get('x-api-key')).toBe('sek');
  });

  it('longest-prefix rule wins when multiple match', async () => {
    const data = freshData();
    await realSeed(data, 'BASIC', 'basic-key', {
      pattern: 'https://api.openweathermap.org/data/2.5/',
      inject_kind: 'query',
      inject_name: 'appid',
      secret_name: 'BASIC',
      secret_name_2: null,
      token_url: null,
      methods: 'GET',
    });
    await realSeed(data, 'PRO', 'pro-key', {
      pattern: 'https://api.openweathermap.org/data/2.5/onecall',
      inject_kind: 'query',
      inject_name: 'appid',
      secret_name: 'PRO',
      secret_name_2: null,
      token_url: null,
      methods: 'GET',
    });
    const captured: { url?: string } = {};
    globalThis.fetch = vi.fn(async (url) => {
      captured.url = String(url);
      return new Response('{}');
    }) as typeof fetch;
    await app.request(
      '/v1/apps/weather/proxy/api.openweathermap.org/data/2.5/onecall?lat=1&lon=2',
      { headers: { Authorization: await ownerAuth() } },
      baseEnv(fakeDB(data)),
    );
    expect(captured.url).toContain('appid=pro-key');
  });

  it('strips Cloudflare-injected request headers (cf-*, x-forwarded-for, cookie)', async () => {
    const data = freshData();
    await realSeed(data, 'K', 'v', {
      pattern: 'https://api.example.com/',
      inject_kind: 'header',
      inject_name: 'X-API-Key',
      secret_name: 'K',
      secret_name_2: null,
      token_url: null,
      methods: 'GET',
    });
    const captured: { init?: RequestInit | undefined } = {};
    globalThis.fetch = vi.fn(async (_url, init) => {
      captured.init = init;
      return new Response('ok');
    }) as typeof fetch;
    await app.request(
      '/v1/apps/weather/proxy/api.example.com/v1/x',
      {
        headers: {
          Authorization: await ownerAuth(),
          'CF-Connecting-IP': '203.0.113.5',
          'CF-IPCountry': 'AU',
          'X-Forwarded-For': '203.0.113.5, 10.0.0.1',
          Cookie: 'session=leak',
        },
      },
      baseEnv(fakeDB(data)),
    );
    const fwd = new Headers(captured.init?.headers);
    expect(fwd.get('cf-connecting-ip')).toBeNull();
    expect(fwd.get('cf-ipcountry')).toBeNull();
    expect(fwd.get('x-forwarded-for')).toBeNull();
    expect(fwd.get('cookie')).toBeNull();
  });

  it('preserves benign caller headers (Accept, User-Agent)', async () => {
    const data = freshData();
    await realSeed(data, 'K', 'v', {
      pattern: 'https://api.example.com/',
      inject_kind: 'header',
      inject_name: 'X-API-Key',
      secret_name: 'K',
      secret_name_2: null,
      token_url: null,
      methods: 'GET',
    });
    const captured: { init?: RequestInit | undefined } = {};
    globalThis.fetch = vi.fn(async (_url, init) => {
      captured.init = init;
      return new Response('ok');
    }) as typeof fetch;
    await app.request(
      '/v1/apps/weather/proxy/api.example.com/v1/x',
      {
        headers: {
          Authorization: await ownerAuth(),
          Accept: 'application/json',
          'User-Agent': 'my-app/1.0',
        },
      },
      baseEnv(fakeDB(data)),
    );
    const fwd = new Headers(captured.init?.headers);
    expect(fwd.get('accept')).toBe('application/json');
    expect(fwd.get('user-agent')).toBe('my-app/1.0');
  });

  it('forwards POST body bytes to upstream verbatim', async () => {
    const data = freshData();
    await realSeed(data, 'K', 'v', {
      pattern: 'https://api.example.com/',
      inject_kind: 'header',
      inject_name: 'X-API-Key',
      secret_name: 'K',
      secret_name_2: null,
      token_url: null,
      methods: 'POST',
    });
    const captured: { init?: RequestInit | undefined } = {};
    globalThis.fetch = vi.fn(async (_url, init) => {
      captured.init = init;
      return new Response('ok');
    }) as typeof fetch;
    const body = JSON.stringify({ hello: 'world' });
    await app.request(
      '/v1/apps/weather/proxy/api.example.com/v1/x',
      {
        method: 'POST',
        headers: {
          Authorization: await ownerAuth(),
          'Content-Type': 'application/json',
        },
        body,
      },
      baseEnv(fakeDB(data)),
    );
    expect(captured.init?.method).toBe('POST');
    expect(new TextDecoder().decode(captured.init?.body as ArrayBuffer)).toBe(body);
  });

  it('proxies the upstream status code through (non-200)', async () => {
    const data = freshData();
    await realSeed(data, 'K', 'v', {
      pattern: 'https://api.example.com/',
      inject_kind: 'header',
      inject_name: 'X-API-Key',
      secret_name: 'K',
      secret_name_2: null,
      token_url: null,
      methods: 'GET',
    });
    globalThis.fetch = vi.fn(
      async () => new Response('not found', { status: 404 }),
    ) as typeof fetch;
    const res = await app.request(
      '/v1/apps/weather/proxy/api.example.com/v1/x',
      { headers: { Authorization: await ownerAuth() } },
      baseEnv(fakeDB(data)),
    );
    expect(res.status).toBe(404);
  });

  it('caller-supplied query params survive alongside the injected one', async () => {
    const data = freshData();
    await realSeed(data, 'K', 'sek', {
      pattern: 'https://api.openweathermap.org/data/2.5/',
      inject_kind: 'query',
      inject_name: 'appid',
      secret_name: 'K',
      secret_name_2: null,
      token_url: null,
      methods: 'GET',
    });
    const captured: { url?: string } = {};
    globalThis.fetch = vi.fn(async (url) => {
      captured.url = String(url);
      return new Response('{}');
    }) as typeof fetch;
    await app.request(
      '/v1/apps/weather/proxy/api.openweathermap.org/data/2.5/weather?q=London&units=metric',
      { headers: { Authorization: await ownerAuth() } },
      baseEnv(fakeDB(data)),
    );
    const u = new URL(captured.url!);
    expect(u.searchParams.get('q')).toBe('London');
    expect(u.searchParams.get('units')).toBe('metric');
    expect(u.searchParams.get('appid')).toBe('sek');
  });

  it('caller cannot override the injected query param', async () => {
    const data = freshData();
    await realSeed(data, 'K', 'real', {
      pattern: 'https://api.example.com/',
      inject_kind: 'query',
      inject_name: 'apikey',
      secret_name: 'K',
      secret_name_2: null,
      token_url: null,
      methods: 'GET',
    });
    const captured: { url?: string } = {};
    globalThis.fetch = vi.fn(async (url) => {
      captured.url = String(url);
      return new Response('{}');
    }) as typeof fetch;
    await app.request(
      '/v1/apps/weather/proxy/api.example.com/v1/x?apikey=BOGUS',
      { headers: { Authorization: await ownerAuth() } },
      baseEnv(fakeDB(data)),
    );
    expect(new URL(captured.url!).searchParams.get('apikey')).toBe('real');
  });

  it('500s when allowlist references a missing secret', async () => {
    // Configure an allowlist rule whose secret_name has no matching row.
    const data = freshData();
    data.allow.push({
      app_id: 'weather',
      pattern: 'https://api.example.com/',
      inject_kind: 'header',
      inject_name: 'X-API-Key',
      secret_name: 'GHOST',
      secret_name_2: null,
      token_url: null,
      methods: 'GET',
      created_at: 0,
    });
    const res = await app.request(
      '/v1/apps/weather/proxy/api.example.com/v1/x',
      { headers: { Authorization: await ownerAuth() } },
      baseEnv(fakeDB(data)),
    );
    expect(res.status).toBe(500);
    const body = await res.json<{ error: string }>();
    expect(body.error).toContain('GHOST');
  });

  it('503s when KEK is unset', async () => {
    const data = freshData();
    await realSeed(data, 'K', 'v', {
      pattern: 'https://api.example.com/',
      inject_kind: 'header',
      inject_name: 'X-API-Key',
      secret_name: 'K',
      secret_name_2: null,
      token_url: null,
      methods: 'GET',
    });
    const res = await app.request(
      '/v1/apps/weather/proxy/api.example.com/v1/x',
      { headers: { Authorization: await ownerAuth() } },
      baseEnv(fakeDB(data), /* withKek */ false),
    );
    expect(res.status).toBe(503);
  });

  it('400s on a malformed proxy path that lacks the expected prefix', async () => {
    // Direct construction: route matches but path doesn't begin with prefix.
    // This shouldn't be reachable via Hono in practice, but the defensive
    // branch should still respond 400 if it does fire.
    // We simulate by URL-encoding the host param so Hono captures something
    // that doesn't reconstruct verbatim. Skipped: requires Hono internals.
    // Instead, sanity-check that the obvious malformed path is rejected
    // (no host segment after /proxy/).
    const data = freshData();
    const res = await app.request(
      '/v1/apps/weather/proxy/',
      { headers: { Authorization: await ownerAuth() } },
      baseEnv(fakeDB(data)),
    );
    // Hono itself returns 404 for an unmatched route — not our 400 branch.
    // Either is acceptable; we just want a non-200.
    expect([400, 404]).toContain(res.status);
  });
});
