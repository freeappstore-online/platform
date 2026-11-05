import { describe, expect, it } from 'vitest';
import { app } from '../index.js';
import { hasSqlite, sqliteD1 } from '../lib/sqlite-d1.testutil.js';
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
  const { db, d1 } = sqliteD1();
  const insert = db.prepare(
    'INSERT INTO audit_results (app_id, store, check_name, status, detail, checked_at) VALUES (?, ?, ?, ?, ?, ?)',
  );
  for (const r of rows)
    insert.run(r.app_id, r.store, r.check_name, r.status, r.detail, r.checked_at);
  return d1;
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
  {
    app_id: 'tip',
    store: 'apps',
    check_name: 'Reachable',
    status: 'pass',
    detail: null,
    checked_at: 100,
  },
  {
    app_id: 'tip',
    store: 'apps',
    check_name: 'Brand fonts (live)',
    status: 'pass',
    detail: null,
    checked_at: 100,
  },
  {
    app_id: 'tip',
    store: 'apps',
    check_name: 'No tracking SDKs (live)',
    status: 'fail',
    detail: '1 matched',
    checked_at: 100,
  },
  {
    app_id: 'asteroids',
    store: 'games',
    check_name: 'Reachable',
    status: 'pass',
    detail: null,
    checked_at: 200,
  },
  {
    app_id: 'asteroids',
    store: 'games',
    check_name: 'PWA manifest (live)',
    status: 'warn',
    detail: 'soft',
    checked_at: 200,
  },
];

describe.skipIf(!hasSqlite)('GET /v1/audit', () => {
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
    expect(c.appId).toBeDefined();
    expect(c.checkName).toBeDefined();
    expect(c.checkedAt).toBeDefined();
    // Snake_case fields must NOT leak through.
    expect(c.app_id).toBeUndefined();
    expect(c.check_name).toBeUndefined();
  });

  it('rolls up per-app summary with pass/warn/fail counts', async () => {
    const res = await app.request('/v1/audit', {}, baseEnv(fakeDB(sample)));
    const body = (await res.json()) as {
      summary: Array<{
        appId: string;
        pass: number;
        warn: number;
        fail: number;
        checkedAt: number;
      }>;
    };
    expect(body.summary).toHaveLength(2);
    const tip = body.summary.find((s) => s.appId === 'tip')!;
    const ast = body.summary.find((s) => s.appId === 'asteroids')!;
    expect(tip).toEqual({ appId: 'tip', store: 'apps', pass: 2, warn: 0, fail: 1, checkedAt: 100 });
    expect(ast).toEqual({
      appId: 'asteroids',
      store: 'games',
      pass: 1,
      warn: 1,
      fail: 0,
      checkedAt: 200,
    });
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

  it('pages checks with ?limit=&offset= and reports the total (#429)', async () => {
    const db = fakeDB(sample);
    const key = (c: { appId: string; checkName: string }) => `${c.appId}/${c.checkName}`;
    const p1 = (await (await app.request('/v1/audit?limit=2', {}, baseEnv(db))).json()) as {
      checks: Array<{ appId: string; checkName: string }>;
      total: number;
    };
    expect(p1.checks).toHaveLength(2);
    expect(p1.total).toBe(sample.length);
    const p2 = (await (
      await app.request('/v1/audit?limit=2&offset=2', {}, baseEnv(db))
    ).json()) as { checks: Array<{ appId: string; checkName: string }> };
    expect(p2.checks).toHaveLength(2);
    expect(p2.checks.map(key)).not.toContain(key(p1.checks[0]!));
  });

  it('defaults the page to 100 checks and caps it at 500', async () => {
    const many: AuditRow[] = Array.from({ length: 600 }, (_, i) => ({
      app_id: `app${i}`,
      store: 'apps',
      check_name: 'Reachable',
      status: 'pass',
      detail: null,
      checked_at: i,
    }));
    const db = fakeDB(many);
    const def = (await (await app.request('/v1/audit', {}, baseEnv(db))).json()) as {
      checks: unknown[];
      total: number;
    };
    expect(def.checks).toHaveLength(100);
    expect(def.total).toBe(600);
    const big = (await (await app.request('/v1/audit?limit=10000', {}, baseEnv(db))).json()) as {
      checks: unknown[];
    };
    expect(big.checks).toHaveLength(500);
  });

  it('summary covers every matching app, not just the current page', async () => {
    const res = await app.request('/v1/audit?limit=1', {}, baseEnv(fakeDB(sample)));
    const body = (await res.json()) as { summary: unknown[]; checks: unknown[] };
    expect(body.checks).toHaveLength(1);
    expect(body.summary).toHaveLength(2);
  });
});
