import { describe, expect, it } from 'vitest';
import { app } from '../index.js';
import type { Env } from '../types.js';

interface HealthCheckRow {
  target: string;
  url: string;
  ok: number;
  status: number | null;
  duration_ms: number;
  error: string | null;
  checked_at: number;
}

function fakeDB(rows: HealthCheckRow[]): D1Database {
  return {
    prepare: () => {
      const stmt: Partial<D1PreparedStatement> = {
        bind: () => stmt as D1PreparedStatement,
        all: async <T>() =>
          ({ results: rows as unknown as T[], success: true, meta: {} }) as unknown as D1Result<T>,
      };
      return stmt as D1PreparedStatement;
    },
  } as unknown as D1Database;
}

const baseEnv = (db: D1Database): Env => ({
  DB: db,
  ROOM: {} as DurableObjectNamespace,
  GITHUB_CLIENT_ID: 'cid',
  GITHUB_CLIENT_SECRET: 'csec',
  SESSION_SIGNING_KEY: 'a'.repeat(64),
});

describe('GET /v1/uptime', () => {
  it('returns ok:true with empty targets when no checks have run', async () => {
    const res = await app.request('/v1/uptime', {}, baseEnv(fakeDB([])));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; targets: unknown[] };
    expect(body.ok).toBe(true);
    expect(body.targets).toEqual([]);
  });

  it('returns ok:true when all targets pass', async () => {
    const res = await app.request(
      '/v1/uptime',
      {},
      baseEnv(
        fakeDB([
          {
            target: 'chess',
            url: 'https://chess.freeappstore.online',
            ok: 1,
            status: 200,
            duration_ms: 80,
            error: null,
            checked_at: 1700000000000,
          },
          {
            target: 'math',
            url: 'https://math.freeappstore.online',
            ok: 1,
            status: 200,
            duration_ms: 60,
            error: null,
            checked_at: 1700000000000,
          },
        ]),
      ),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      ok: boolean;
      targets: { target: string; ok: boolean; status: number | null }[];
    };
    expect(body.ok).toBe(true);
    expect(body.targets).toHaveLength(2);
    expect(body.targets[0]!.ok).toBe(true);
  });

  it('returns ok:false when any target fails', async () => {
    const res = await app.request(
      '/v1/uptime',
      {},
      baseEnv(
        fakeDB([
          {
            target: 'chess',
            url: 'https://chess.freeappstore.online',
            ok: 1,
            status: 200,
            duration_ms: 80,
            error: null,
            checked_at: 1700000000000,
          },
          {
            target: 'broken',
            url: 'https://broken.freeappstore.online',
            ok: 0,
            status: 503,
            duration_ms: 10,
            error: 'http 503',
            checked_at: 1700000000000,
          },
        ]),
      ),
    );
    const body = (await res.json()) as { ok: boolean; targets: { ok: boolean }[] };
    expect(body.ok).toBe(false);
    expect(body.targets.find((t) => !t.ok)).toBeDefined();
  });

  it('exposes camelCased fields (durationMs, checkedAt) in the response', async () => {
    const res = await app.request(
      '/v1/uptime',
      {},
      baseEnv(
        fakeDB([
          {
            target: 'chess',
            url: 'https://chess.freeappstore.online',
            ok: 1,
            status: 200,
            duration_ms: 80,
            error: null,
            checked_at: 1700000000000,
          },
        ]),
      ),
    );
    const body = (await res.json()) as {
      targets: Array<Record<string, unknown>>;
    };
    const t = body.targets[0]!;
    expect(t.durationMs).toBe(80);
    expect(t.checkedAt).toBe(1700000000000);
    // Snake_case fields must NOT leak through.
    expect(t.duration_ms).toBeUndefined();
    expect(t.checked_at).toBeUndefined();
  });
});
