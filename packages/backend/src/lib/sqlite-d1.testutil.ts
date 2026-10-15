/**
 * Test helper: an in-memory SQLite database with every D1 migration applied,
 * behind the slice of the D1 API the routes and cron jobs use. Runs the real
 * SQL (ON CONFLICT, RETURNING, CASE, …) instead of a substring-matching fake.
 * Needs node:sqlite (Node 22.13+); tests should `describe.skipIf(!hasSqlite)`.
 */

interface SqliteStatement {
  all(...binds: unknown[]): unknown[];
  get(...binds: unknown[]): unknown;
  run(...binds: unknown[]): { changes: number | bigint };
}
interface SqliteModule {
  DatabaseSync: new (
    path: string,
  ) => { exec(sql: string): void; prepare(sql: string): SqliteStatement };
}
interface FsModule {
  readdirSync(dir: URL): string[];
  readFileSync(file: URL, encoding: 'utf8'): string;
}
const nodeModule = <T>(name: string) => import(/* @vite-ignore */ name) as Promise<T>;
const sqlite = await nodeModule<SqliteModule>('node:sqlite').catch(() => null);
const fs = await nodeModule<FsModule>('node:fs');
const MIGRATIONS = new URL('../../migrations/', (import.meta as unknown as { url: string }).url);

export const hasSqlite = sqlite !== null;
export type SqliteDb = { exec(sql: string): void; prepare(sql: string): SqliteStatement };

export function sqliteD1(): { db: SqliteDb; d1: D1Database } {
  if (!sqlite) throw new Error('node:sqlite unavailable');
  const db = new sqlite.DatabaseSync(':memory:');
  for (const f of fs
    .readdirSync(MIGRATIONS)
    .filter((name) => name.endsWith('.sql'))
    .sort()) {
    db.exec(fs.readFileSync(new URL(f, MIGRATIONS), 'utf8'));
  }
  const d1 = {
    prepare(sql: string) {
      let binds: unknown[] = [];
      const stmt = {
        bind(...args: unknown[]) {
          binds = args;
          return stmt;
        },
        async all() {
          return { results: db.prepare(sql).all(...binds) };
        },
        async first() {
          return db.prepare(sql).get(...binds) ?? null;
        },
        async run() {
          const r = db.prepare(sql).run(...binds);
          return { meta: { changes: Number(r.changes) } };
        },
      };
      return stmt;
    },
  } as unknown as D1Database;
  return { db, d1 };
}
