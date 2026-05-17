import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { runAudit } from './audit.js';

interface Captured {
  sql: string;
  binds: unknown[];
}

function fakeDB(captures: Captured[]): D1Database {
  return {
    prepare: (sql: string) => {
      const trimmed = sql.replace(/\s+/g, ' ').trim();
      let bound: unknown[] = [];
      const stmt: Partial<D1PreparedStatement> = {
        bind: (...args: unknown[]) => {
          bound = args;
          return { ...stmt, bound: [...bound] } as unknown as D1PreparedStatement;
        },
        run: async <T>() => ({ meta: { changes: 1 } }) as unknown as D1Result<T>,
        // fetchLastCheckedMap calls .all() to read MAX(checked_at) per app.
        // Tests don't seed any rows; returning empty matches "no prior
        // audits" which is the typical scaffold path.
        all: async <T>() =>
          ({ results: [] as unknown as T[], success: true, meta: {} }) as unknown as D1Result<T>,
      };
      return Object.assign(stmt, {
        _captureSql: trimmed,
      }) as unknown as D1PreparedStatement;
    },
    batch: async <T>(statements: D1PreparedStatement[]) => {
      for (const s of statements as Array<
        D1PreparedStatement & { bound?: unknown[]; _captureSql?: string }
      >) {
        captures.push({ sql: s._captureSql ?? '', binds: s.bound ?? [] });
      }
      return Promise.all(
        statements.map(() => ({ meta: { changes: 1 } }) as unknown as D1Result<T>),
      );
    },
  } as unknown as D1Database;
}

describe('runAudit', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn());
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('fetches both registries and audits every entry', async () => {
    const calls: string[] = [];
    (fetch as unknown as ReturnType<typeof vi.fn>).mockImplementation(async (url: string) => {
      calls.push(url);
      // First two calls: registries (apps + games).
      if (/freeappstore-online\/freeappstore.*registry\.json/.test(url)) {
        return new Response(
          JSON.stringify({ apps: [{ id: 'tip', appUrl: 'https://tip.example' }] }),
          { status: 200 },
        );
      }
      if (/freegamestore-online\/freegamestore.*registry\.json/.test(url)) {
        return new Response(
          JSON.stringify({ games: [{ id: 'asteroids', appUrl: 'https://asteroids.example' }] }),
          { status: 200 },
        );
      }
      // Per-app fetches (HTML + manifest + bundle) — return failures
      // so the audit fast-paths to "Reachable: fail" with one result.
      throw new Error('ECONNREFUSED');
    });
    const captures: Captured[] = [];
    const r = await runAudit(fakeDB(captures));
    // 2 registry fetches + each app at least 1 origin fetch attempt.
    expect(calls.some((u) => u.includes('/freeappstore/main/registry.json'))).toBe(true);
    expect(calls.some((u) => u.includes('/freegamestore/main/registry.json'))).toBe(true);
    expect(r.scanned).toBe(2);
    expect(r.failed).toBe(2); // each unreachable → 1 fail check
  });

  it('writes results to D1 with INSERT ... ON CONFLICT', async () => {
    (fetch as unknown as ReturnType<typeof vi.fn>).mockImplementation(async (url: string) => {
      if (/registry\.json/.test(url)) {
        // Two apps, no games.
        return new Response(
          JSON.stringify({
            apps: [
              { id: 'a', appUrl: 'https://a.example' },
              { id: 'b', appUrl: 'https://b.example' },
            ],
          }),
          { status: 200 },
        );
      }
      throw new Error('unreachable');
    });
    const captures: Captured[] = [];
    await runAudit(fakeDB(captures));
    // Each app contributes one "Reachable: fail" row → 2 batch entries.
    // Confirm batch SQL is the upsert pattern.
    expect(captures.length).toBeGreaterThan(0);
    expect(captures[0]!.sql).toMatch(/INSERT INTO audit_results/);
    expect(captures[0]!.sql).toMatch(/ON CONFLICT/);
  });

  it('preserves store column for app vs game', async () => {
    (fetch as unknown as ReturnType<typeof vi.fn>).mockImplementation(async (url: string) => {
      if (/freeappstore.*registry/.test(url)) {
        return new Response(JSON.stringify({ apps: [{ id: 'a', appUrl: 'https://a.example' }] }), {
          status: 200,
        });
      }
      if (/freegamestore.*registry/.test(url)) {
        return new Response(JSON.stringify({ games: [{ id: 'g', appUrl: 'https://g.example' }] }), {
          status: 200,
        });
      }
      throw new Error('x');
    });
    const captures: Captured[] = [];
    await runAudit(fakeDB(captures));
    // bind order is (app_id, store, check_name, status, detail, checked_at).
    const stores = captures.map((c) => ({ appId: c.binds[0], store: c.binds[1] }));
    expect(stores).toContainEqual({ appId: 'a', store: 'apps' });
    expect(stores).toContainEqual({ appId: 'g', store: 'games' });
  });

  it('returns scanned=0 when both registries are empty', async () => {
    // mockImplementation (not mockResolvedValue) so each call gets a
    // fresh Response — Response bodies are single-use.
    (fetch as unknown as ReturnType<typeof vi.fn>).mockImplementation(
      async () => new Response(JSON.stringify({}), { status: 200 }),
    );
    const captures: Captured[] = [];
    const r = await runAudit(fakeDB(captures));
    expect(r.scanned).toBe(0);
    expect(captures).toHaveLength(0);
  });
});
