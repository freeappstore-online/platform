import { describe, it, expect } from 'vitest';
import { app } from '../index.js';
import { signSession } from '../lib/session.js';
import type { Env } from '../types.js';

const SIGNING_KEY = 'a'.repeat(64);

interface FakeRow {
  sql: string;
  args: unknown[];
}

/**
 * Minimal fake D1 driver. The real D1Database is too large to mock fully;
 * we just need prepare().bind().first() and .run() to behave per the test's
 * expectations. The route under test calls it twice for a PUT (auth lookup,
 * then quota query, then the INSERT...ON CONFLICT).
 */
function fakeDB(opts: {
  user?: { id: string; github_login: string; avatar_url: string | null } | null;
  kvUsage?: { total: number; keys: number; key_exists: number; existing: number };
  onWrite?: (row: FakeRow) => void;
}): D1Database {
  const calls: FakeRow[] = [];
  const prepare = (sql: string): D1PreparedStatement => {
    const trimmed = sql.replace(/\s+/g, ' ').trim();
    let bound: unknown[] = [];
    const stmt: Partial<D1PreparedStatement> = {
      bind: (...args: unknown[]) => {
        bound = args;
        return stmt as D1PreparedStatement;
      },
      first: async <T>() => {
        calls.push({ sql: trimmed, args: bound });
        if (trimmed.startsWith('SELECT id, github_login')) {
          return (opts.user ?? null) as T | null;
        }
        if (trimmed.includes('FROM kv WHERE')) {
          return (opts.kvUsage ?? { total: 0, keys: 0, key_exists: 0, existing: 0 }) as T;
        }
        return null;
      },
      run: async <T = Record<string, unknown>>() => {
        calls.push({ sql: trimmed, args: bound });
        opts.onWrite?.({ sql: trimmed, args: bound });
        return { meta: { changes: 1 } } as unknown as D1Result<T>;
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

describe('PUT /v1/apps/:appId/kv/:key', () => {
  it('returns 401 with no Authorization header', async () => {
    const res = await app.request(
      '/v1/apps/myapp/kv/foo',
      { method: 'PUT', body: '"hello"' },
      baseEnv(fakeDB({})),
    );
    expect(res.status).toBe(401);
  });

  it('returns 401 with a valid-shape but wrong-signature token', async () => {
    const token = await signSession('gh:42', 'wrong-key-' + 'x'.repeat(50));
    const res = await app.request(
      '/v1/apps/myapp/kv/foo',
      { method: 'PUT', headers: { Authorization: `Bearer ${token}` }, body: '"hi"' },
      baseEnv(fakeDB({ user: { id: 'gh:42', github_login: 'alice', avatar_url: null } })),
    );
    expect(res.status).toBe(401);
  });

  it('returns 400 for an empty body', async () => {
    const token = await signSession('gh:42', SIGNING_KEY);
    const res = await app.request(
      '/v1/apps/myapp/kv/foo',
      { method: 'PUT', headers: { Authorization: `Bearer ${token}` }, body: '' },
      baseEnv(fakeDB({ user: { id: 'gh:42', github_login: 'alice', avatar_url: null } })),
    );
    expect(res.status).toBe(400);
    expect(await res.text()).toMatch(/empty/i);
  });

  it('returns 204 on a happy-path PUT and writes the expected row', async () => {
    const token = await signSession('gh:42', SIGNING_KEY);
    const writes: FakeRow[] = [];
    const res = await app.request(
      '/v1/apps/myapp/kv/foo',
      { method: 'PUT', headers: { Authorization: `Bearer ${token}` }, body: '"hello"' },
      baseEnv(
        fakeDB({
          user: { id: 'gh:42', github_login: 'alice', avatar_url: null },
          kvUsage: { total: 0, keys: 0, key_exists: 0, existing: 0 },
          onWrite: (row) => writes.push(row),
        }),
      ),
    );
    expect(res.status).toBe(204);
    expect(writes).toHaveLength(1);
    const insert = writes[0]!;
    expect(insert.sql).toMatch(/INSERT INTO kv/);
    // bind order: app_id, user_id, key, value (ArrayBuffer), value_size_bytes, updated_at
    expect(insert.args[0]).toBe('myapp');
    expect(insert.args[1]).toBe('gh:42');
    expect(insert.args[2]).toBe('foo');
    expect(insert.args[4]).toBe(7); // '"hello"' is 7 bytes
  });

  it('returns 413 when the value exceeds maxValueBytes', async () => {
    const token = await signSession('gh:42', SIGNING_KEY);
    const big = JSON.stringify('x'.repeat(64 * 1024)); // 64KB+ once quoted
    const res = await app.request(
      '/v1/apps/myapp/kv/foo',
      { method: 'PUT', headers: { Authorization: `Bearer ${token}` }, body: big },
      baseEnv(
        fakeDB({
          user: { id: 'gh:42', github_login: 'alice', avatar_url: null },
          kvUsage: { total: 0, keys: 0, key_exists: 0, existing: 0 },
        }),
      ),
    );
    expect(res.status).toBe(413);
  });
});
