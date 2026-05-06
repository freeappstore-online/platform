import { describe, it, expect } from 'vitest';
import { app } from '../index.js';
import type { Env } from '../types.js';

interface AuditRow {
  app_id: string;
  store: string;
  check_name: string;
  status: string;
  detail: string | null;
  checked_at: number;
}

function fakeDB(rows: AuditRow[]): D1Database {
  return {
    prepare: (sql: string) => {
      const trimmed = sql.replace(/\s+/g, ' ').trim();
      let bound: unknown[] = [];
      const stmt: Partial<D1PreparedStatement> = {
        bind: (...args: unknown[]) => {
          bound = args;
          return stmt as D1PreparedStatement;
        },
        all: async <T>() => {
          // Apply WHERE filters in JS so each test can pre-seed rows
          // without writing matching SQL.
          let filtered = rows.slice();
          if (trimmed.includes('store = ?')) {
            const want = bound.shift();
            filtered = filtered.filter((r) => r.store === want);
          }
          if (trimmed.includes('status = ?')) {
            const want = bound.shift();
            filtered = filtered.filter((r) => r.status === want);
          }
          if (trimmed.includes('app_id = ?')) {
            const want = bound.shift();
            filtered = filtered.filter((r) => r.app_id === want);
          }
          return {
            results: filtered as unknown as T[],
            success: true,
            meta: {},
          } as unknown as D1Result<T>;
        },
      };
      return stmt as D1PreparedStatement;
    },
  } as unknown as D1Database;
}

const baseEnv = (db: D1Database): Env =>
  ({
    DB: db,
    ROOM: {} as DurableObjectNamespace,
    GITHUB_CLIENT_ID: 'cid',
    GITHUB_CLIENT_SECRET: 'csec',
    SESSION_SIGNING_KEY: 'a'.repeat(64),
  }) as Env;

const sample: AuditRow[] = [
  { app_id: 'tip', store: 'apps', check_name: 'Reachable', status: 'pass', detail: null, checked_at: 100 },
  { app_id: 'tip', store: 'apps', check_name: 'Brand fonts (live)', status: 'pass', detail: null, checked_at: 100 },
  { app_id: 'tip', store: 'apps', check_name: 'No tracking SDKs (live)', status: 'fail', detail: '1 matched', checked_at: 100 },
  { app_id: 'asteroids', store: 'games', check_name: 'Reachable', status: 'pass', detail: null, checked_at: 200 },
  { app_id: 'asteroids', store: 'games', check_name: 'PWA manifest (live)', status: 'warn', detail: 'soft', checked_at: 200 },
];

describe('GET /v1/audit', () => {
  it('returns empty arrays when there are no rows', async () => {
    const res = await app.request('/v1/audit', {}, baseEnv(fakeDB([])));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { summary: unknown[]; checks: unknown[] };
    expect(body.summary).toEqual([]);
    expect(body.checks).toEqual([]);
  });

  it('returns rows in camelCase shape', async () => {
    const res = await app.request('/v1/audit', {}, baseEnv(fakeDB(sample)));
    const body = (await res.json()) as { checks: Array<Record<string, unknown>> };
    const c = body.checks[0]!;
    expect(c['appId']).toBeDefined();
    expect(c['checkName']).toBeDefined();
    expect(c['checkedAt']).toBeDefined();
    // Snake_case fields must NOT leak through.
    expect(c['app_id']).toBeUndefined();
    expect(c['check_name']).toBeUndefined();
  });

  it('rolls up per-app summary with pass/warn/fail counts', async () => {
    const res = await app.request('/v1/audit', {}, baseEnv(fakeDB(sample)));
    const body = (await res.json()) as {
      summary: Array<{ appId: string; pass: number; warn: number; fail: number; checkedAt: number }>;
    };
    expect(body.summary).toHaveLength(2);
    const tip = body.summary.find((s) => s.appId === 'tip')!;
    const ast = body.summary.find((s) => s.appId === 'asteroids')!;
    expect(tip).toEqual({ appId: 'tip', store: 'apps', pass: 2, warn: 0, fail: 1, checkedAt: 100 });
    expect(ast).toEqual({ appId: 'asteroids', store: 'games', pass: 1, warn: 1, fail: 0, checkedAt: 200 });
  });

  it('filters by ?store=games', async () => {
    const res = await app.request('/v1/audit?store=games', {}, baseEnv(fakeDB(sample)));
    const body = (await res.json()) as { checks: Array<{ store: string }> };
    expect(body.checks.length).toBeGreaterThan(0);
    expect(body.checks.every((c) => c.store === 'games')).toBe(true);
  });

  it('filters by ?status=fail', async () => {
    const res = await app.request('/v1/audit?status=fail', {}, baseEnv(fakeDB(sample)));
    const body = (await res.json()) as { checks: Array<{ status: string }> };
    expect(body.checks.length).toBeGreaterThan(0);
    expect(body.checks.every((c) => c.status === 'fail')).toBe(true);
  });

  it('filters by ?app=<id>', async () => {
    const res = await app.request('/v1/audit?app=tip', {}, baseEnv(fakeDB(sample)));
    const body = (await res.json()) as { checks: Array<{ appId: string }> };
    expect(body.checks.every((c) => c.appId === 'tip')).toBe(true);
  });

  it('ignores unknown filter values rather than 400ing', async () => {
    // ?store=not-a-store is a no-op (not 'apps' or 'games', so no WHERE).
    const res = await app.request('/v1/audit?store=bogus', {}, baseEnv(fakeDB(sample)));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { checks: unknown[] };
    expect(body.checks).toHaveLength(sample.length);
  });
});
