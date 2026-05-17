import { describe, expect, it } from 'vitest';
import { backupD1ToR2 } from './backup.js';

interface FakeR2Put {
  key: string;
  body: string;
  contentType?: string | undefined;
}

function fakeDB(rowsByTable: Record<string, unknown[]>): D1Database {
  return {
    prepare: (sql: string) => {
      const trimmed = sql.replace(/\s+/g, ' ').trim();
      // Match the FROM <table> at the end of the SELECT.
      const m = /FROM (\w+)/.exec(trimmed);
      const table = m ? m[1] : '?';
      return {
        all: async <T>() => ({
          results: (rowsByTable[table!] ?? []) as T[],
          success: true,
          meta: {},
        }),
      } as unknown as D1PreparedStatement;
    },
  } as unknown as D1Database;
}

function fakeR2(): { bucket: R2Bucket; puts: FakeR2Put[] } {
  const puts: FakeR2Put[] = [];
  const bucket: Partial<R2Bucket> = {
    put: async (key, body, options) => {
      const text = typeof body === 'string' ? body : '';
      const md = options?.httpMetadata;
      const contentType =
        md instanceof Headers ? (md.get('content-type') ?? undefined) : md?.contentType;
      puts.push({ key, body: text, contentType });
      return {} as R2Object;
    },
  };
  return { bucket: bucket as R2Bucket, puts };
}

describe('backupD1ToR2', () => {
  it('writes a dated key under db-backups/', async () => {
    const { bucket, puts } = fakeR2();
    const result = await backupD1ToR2(
      fakeDB({ users: [], apps: [], health_checks: [], kv: [] }),
      bucket,
      Date.parse('2026-05-05T03:00:00Z'),
    );
    expect(result.key).toBe('db-backups/2026-05-05/fas.json');
    expect(puts).toHaveLength(1);
    expect(puts[0]!.key).toBe('db-backups/2026-05-05/fas.json');
  });

  it('writes valid JSON with the documented v1 envelope', async () => {
    const { bucket, puts } = fakeR2();
    await backupD1ToR2(
      fakeDB({ users: [], apps: [], health_checks: [], kv: [] }),
      bucket,
      Date.parse('2026-05-05T00:00:00Z'),
    );
    const parsed = JSON.parse(puts[0]!.body);
    expect(parsed.version).toBe(1);
    expect(parsed.exportedAt).toBe(Date.parse('2026-05-05T00:00:00Z'));
    expect(parsed.tables).toEqual({ users: [], apps: [], health_checks: [], kv: [] });
  });

  it('returns row counts for each backed-up table', async () => {
    const { bucket } = fakeR2();
    const result = await backupD1ToR2(
      fakeDB({
        users: [{ id: 'gh:1' }, { id: 'gh:2' }],
        apps: [{ id: 'chess' }],
        health_checks: [],
        kv: [{ key: 'x', value_hex: '7B7D' }],
      }),
      bucket,
    );
    expect(result.rowsByTable).toEqual({
      users: 2,
      apps: 1,
      health_checks: 0,
      kv: 1,
    });
  });

  it('preserves kv BLOB values as hex (round-trip survives JSON)', async () => {
    const { bucket, puts } = fakeR2();
    // kv table comes back from the SELECT with hex(value) AS value_hex —
    // verify we round-trip that through the JSON envelope.
    await backupD1ToR2(
      fakeDB({
        users: [],
        apps: [],
        health_checks: [],
        kv: [
          {
            app_id: 'a',
            user_id: 'gh:1',
            key: 'foo',
            // hex of '{"hi":"there"}' — verify with `xxd -r -p` decodes to JSON.
            value_hex: '7b226869223a227468657265227d',
            value_size_bytes: 14,
            updated_at: 1700000000000,
          },
        ],
      }),
      bucket,
    );
    const parsed = JSON.parse(puts[0]!.body);
    expect(parsed.tables.kv[0].value_hex).toBe('7b226869223a227468657265227d');
    expect(Buffer.from(parsed.tables.kv[0].value_hex, 'hex').toString()).toBe('{"hi":"there"}');
  });

  it('sets content-type application/json on the R2 object', async () => {
    const { bucket, puts } = fakeR2();
    await backupD1ToR2(fakeDB({ users: [], apps: [], health_checks: [], kv: [] }), bucket);
    expect(puts[0]!.contentType).toBe('application/json');
  });
});
