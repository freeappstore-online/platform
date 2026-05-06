import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import worker from './index.js';
import type { Env } from './types.js';

interface DBCall {
  sql: string;
  binds: unknown[][];
}

function fakeDB(opts: { onPrepare?: (call: DBCall) => void } = {}): D1Database {
  const trackPrepare = (sql: string): D1PreparedStatement => {
    const trimmed = sql.replace(/\s+/g, ' ').trim();
    const collected: unknown[][] = [];
    const stmt: Partial<D1PreparedStatement> = {
      bind: (...args: unknown[]) => {
        collected.push(args);
        return stmt as D1PreparedStatement;
      },
      run: async <T = Record<string, unknown>>() => {
        opts.onPrepare?.({ sql: trimmed, binds: collected });
        return { meta: { changes: 1 } } as unknown as D1Result<T>;
      },
    };
    return stmt as D1PreparedStatement;
  };
  return {
    prepare: trackPrepare,
    batch: async (statements: D1PreparedStatement[]) => {
      // Simulate batch by treating each statement as an independent run.
      return Promise.all(statements.map((s) => s.run()));
    },
  } as unknown as D1Database;
}

const baseEnv = (db: D1Database, overrides: Partial<Env> = {}): Env => ({
  DB: db,
  ROOM: {} as DurableObjectNamespace,
  GITHUB_CLIENT_ID: 'cid',
  GITHUB_CLIENT_SECRET: 'csec',
  SESSION_SIGNING_KEY: 'a'.repeat(64),
  ...overrides,
});

const fakeCtx = {} as ExecutionContext;

beforeEach(() => {
  // Stub fetch for uptime checks.
  globalThis.fetch = vi.fn().mockResolvedValue(new Response('ok', { status: 200 }));
});

afterEach(() => {
  delete (globalThis as Record<string, unknown>)['fetch'];
});

describe('scheduled() — */15 cron (uptime checks)', () => {
  it('inserts one health_check row per target and one delete-old row', async () => {
    const calls: DBCall[] = [];
    const env = baseEnv(fakeDB({ onPrepare: (c) => calls.push(c) }));
    const event = { cron: '*/15 * * * *' } as ScheduledEvent;

    await worker.scheduled(event, env, fakeCtx);

    const inserts = calls.filter((c) => c.sql.startsWith('INSERT INTO health_checks'));
    const deletes = calls.filter((c) => c.sql.startsWith('DELETE FROM health_checks'));

    expect(inserts.length).toBeGreaterThan(0);
    expect(deletes).toHaveLength(1);
    // One bind per target, each with 7 args (target, url, ok, status,
    // duration_ms, error, checked_at).
    const allBinds = inserts[0]!.binds;
    expect(allBinds.length).toBeGreaterThan(0);
    expect(allBinds[0]!.length).toBe(7);
  });

  it('records ok=1 when fetch returns 200, ok=0 when fetch fails', async () => {
    // mockResolvedValueOnce/mockRejectedValueOnce queues are unreliable
    // with the parallel Promise.all the cron uses. Use a counter that
    // deterministically fails the 2nd call regardless of resolution order.
    let n = 0;
    globalThis.fetch = vi.fn(async () => {
      n++;
      if (n === 2) throw new Error('ECONNREFUSED');
      return new Response('ok', { status: 200 });
    });
    const calls: DBCall[] = [];
    const env = baseEnv(fakeDB({ onPrepare: (c) => calls.push(c) }));
    await worker.scheduled({ cron: '*/15 * * * *' } as ScheduledEvent, env, fakeCtx);

    const inserts = calls.filter((c) => c.sql.startsWith('INSERT INTO health_checks'));
    // The fake re-uses one stmt across all binds, so all inserts share the
    // same binds array; iterate every bind call (one per target) and check ok.
    const allBinds = inserts[0]!.binds;
    const okValues = allBinds.map((b) => b[2]); // bind index 2 = ok
    expect(okValues).toContain(1); // success rows
    expect(okValues).toContain(0); // the rejected one
  });
});

describe('scheduled() — 0 4 cron (daily backup)', () => {
  it('skips when BACKUPS binding is missing (no R2 enabled)', async () => {
    const calls: DBCall[] = [];
    const env = baseEnv(fakeDB({ onPrepare: (c) => calls.push(c) }));
    // No env.BACKUPS — should log + skip without crashing.
    const event = { cron: '0 4 * * *' } as ScheduledEvent;

    await expect(worker.scheduled(event, env, fakeCtx)).resolves.toBeUndefined();
    // No D1 writes expected on the skip path.
    expect(calls).toHaveLength(0);
  });

  it('writes a backup to R2 when BACKUPS is bound', async () => {
    const puts: { key: string; body: string }[] = [];
    const bucket: Partial<R2Bucket> = {
      put: async (key, body) => {
        puts.push({ key, body: typeof body === 'string' ? body : '' });
        return {} as R2Object;
      },
    };
    const env = baseEnv(fakeDB(), { BACKUPS: bucket as R2Bucket });
    // Override prepare to also support .all() since backup queries via SELECT.
    env.DB = {
      prepare: () => {
        const stmt: Partial<D1PreparedStatement> = {
          bind: () => stmt as D1PreparedStatement,
          all: async <T>() => ({ results: [] as unknown as T[], success: true, meta: {} }) as unknown as D1Result<T>,
        };
        return stmt as D1PreparedStatement;
      },
    } as unknown as D1Database;

    await worker.scheduled({ cron: '0 4 * * *' } as ScheduledEvent, env, fakeCtx);

    expect(puts).toHaveLength(1);
    expect(puts[0]!.key).toMatch(/^db-backups\/\d{4}-\d{2}-\d{2}\/fas\.json$/);
  });
});

describe('scheduled() — unknown cron', () => {
  it('does nothing for an unrecognized cron expression (no throw)', async () => {
    const calls: DBCall[] = [];
    const env = baseEnv(fakeDB({ onPrepare: (c) => calls.push(c) }));
    await expect(
      worker.scheduled({ cron: '0 0 1 1 *' } as ScheduledEvent, env, fakeCtx),
    ).resolves.toBeUndefined();
    expect(calls).toHaveLength(0);
  });
});
