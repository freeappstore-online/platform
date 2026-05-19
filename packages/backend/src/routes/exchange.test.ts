import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { app } from '../index.js';
import type { Env } from '../types.js';

const SIGNING_KEY = 'a'.repeat(64);

interface FakeWrite {
  sql: string;
  args: unknown[];
}

function fakeDB(opts: { onUserUpsert?: (row: FakeWrite) => void } = {}): D1Database {
  const prepare = (sql: string): D1PreparedStatement => {
    const trimmed = sql.replace(/\s+/g, ' ').trim();
    let bound: unknown[] = [];
    const stmt: Partial<D1PreparedStatement> = {
      bind: (...args: unknown[]) => {
        bound = args;
        return stmt as D1PreparedStatement;
      },
      run: async <T = Record<string, unknown>>() => {
        if (trimmed.startsWith('INSERT INTO users')) {
          opts.onUserUpsert?.({ sql: trimmed, args: bound });
        }
        return { meta: { changes: 1 } } as unknown as D1Result<T>;
      },
      first: async <T = unknown>() => {
        if (trimmed.startsWith('SELECT date_of_birth FROM users')) {
          return { date_of_birth: null } as T;
        }
        return null as T;
      },
    };
    return stmt as D1PreparedStatement;
  };
  return { prepare } as unknown as D1Database;
}

const baseEnv = (db: D1Database): Env => ({
  DB: db,
  ROOM: {} as DurableObjectNamespace,
  GITHUB_CLIENT_ID: 'cid',
  GITHUB_CLIENT_SECRET: 'csec',
  SESSION_SIGNING_KEY: SIGNING_KEY,
});

describe('POST /v1/auth/exchange', () => {
  let originalFetch: typeof fetch;
  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it('returns 400 when the body is not JSON', async () => {
    const res = await app.request(
      '/v1/auth/exchange',
      { method: 'POST', body: 'not json' },
      baseEnv(fakeDB()),
    );
    expect(res.status).toBe(400);
  });

  it('returns 400 when githubToken is missing', async () => {
    const res = await app.request(
      '/v1/auth/exchange',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      },
      baseEnv(fakeDB()),
    );
    expect(res.status).toBe(400);
  });

  it('returns 401 when GitHub rejects the token', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(new Response('', { status: 401 }));
    const res = await app.request(
      '/v1/auth/exchange',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ githubToken: 'gho_bogus' }),
      },
      baseEnv(fakeDB()),
    );
    expect(res.status).toBe(401);
  });

  it('returns 502 when GitHub is unreachable / 5xx', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(new Response('', { status: 503 }));
    const res = await app.request(
      '/v1/auth/exchange',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ githubToken: 'gho_x' }),
      },
      baseEnv(fakeDB()),
    );
    expect(res.status).toBe(502);
  });

  it('mints a session and upserts the user on a valid GitHub token', async () => {
    globalThis.fetch = vi
      .fn()
      .mockResolvedValue(
        new Response(
          JSON.stringify({ id: 12345, login: 'alice', avatar_url: 'https://avatars/alice' }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        ),
      );
    const writes: FakeWrite[] = [];
    const res = await app.request(
      '/v1/auth/exchange',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ githubToken: 'gho_real' }),
      },
      baseEnv(fakeDB({ onUserUpsert: (w) => writes.push(w) })),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      sessionToken: string;
      user: { id: string; login: string };
    };
    expect(body.sessionToken).toMatch(/\..+/); // base64url.body.signature shape
    expect(body.user).toEqual({
      id: 'gh:12345',
      login: 'alice',
      avatarUrl: 'https://avatars/alice',
      dateOfBirth: null,
    });
    expect(writes).toHaveLength(1);
    expect(writes[0]!.args).toEqual([
      'gh:12345',
      12345,
      'alice',
      'https://avatars/alice',
      expect.any(Number),
    ]);
  });
});
