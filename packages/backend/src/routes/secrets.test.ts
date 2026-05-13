import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { app } from '../index.js';
import type { Env } from '../types.js';
import { signSession } from '../lib/session.js';

const SIGNING_KEY = 'a'.repeat(64);
const KEK = btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32))));

interface UserRow {
  id: string;
  github_login: string;
  avatar_url: string | null;
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
  if (sql.startsWith('SELECT id, github_login, avatar_url FROM users')) {
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
      'SELECT pattern, inject_kind, inject_name, secret_name, methods, created_at FROM app_proxy_allowlist',
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
    const [app_id, pattern, inject_kind, inject_name, secret_name, methods, created_at] =
      bound as [string, string, string, string, string, string, number];
    const idx = d.allow.findIndex((r) => r.app_id === app_id && r.pattern === pattern);
    const row: AllowRow = {
      app_id,
      pattern,
      inject_kind,
      inject_name,
      secret_name,
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


const owner: UserRow = { id: 'gh:1', github_login: 'alice', avatar_url: null };
const stranger: UserRow = { id: 'gh:2', github_login: 'mallory', avatar_url: null };
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
      methods: 'GET',
    });
    const res = await app.request(
      '/v1/apps/weather/proxy/api.openweathermap.org/data/2.5/weather',
      { headers: { Authorization: await ownerAuth() } },
      baseEnv(fakeDB(data)),
    );
    expect(res.status).toBe(403);
  });

  it('injects a query secret and forwards the request', async () => {
    const data = freshData();
    await realSeed(data, 'OPENWEATHER_KEY', 'sk-real', {
      pattern: 'https://api.openweathermap.org/data/2.5/',
      inject_kind: 'query',
      inject_name: 'appid',
      secret_name: 'OPENWEATHER_KEY',
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
});

