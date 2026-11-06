import { describe, expect, it } from "vitest";
import { ROUTE_LOOKUP_SQL, wantsCrossOriginIsolation } from "../host";

// workers-types is the only tsconfig `types` entry, so node builtins are loaded
// the same way as the backend sqlite helper: a typed dynamic import.
interface SqliteStatement {
  all(...binds: unknown[]): unknown[];
  get(...binds: unknown[]): unknown;
  run(...binds: unknown[]): unknown;
}
interface SqliteModule {
  DatabaseSync: new (path: string) => { exec(sql: string): void; prepare(sql: string): SqliteStatement };
}
interface FsModule {
  readFileSync(file: URL, encoding: "utf8"): string;
}
const nodeModule = <T>(name: string) => import(/* @vite-ignore */ name) as Promise<T>;

interface RouteInfo {
  name: string;
  notnull: number;
  dflt_value: string | null;
}
interface RouteRow {
  slug: string;
  r2_prefix: string;
  cross_origin_isolated: number;
}

describe("unmigrated routes schema (#308)", () => {
  it("rejects the host lookup until 0002 runs, then defaults existing apps off", async () => {
    const sqlite = await nodeModule<SqliteModule>("node:sqlite");
    const fs = await nodeModule<FsModule>("node:fs");
    const migrations = new URL("../../migrations/", (import.meta as unknown as { url: string }).url);
    const sql = (name: string) => fs.readFileSync(new URL(name, migrations), "utf8");
    const db = new sqlite.DatabaseSync(":memory:");
    db.exec(sql("0001_create_routes.sql"));
    db.prepare(
      `INSERT INTO routes (slug, zone, r2_prefix, store, hosted_on, created_at, updated_at)
       VALUES ('kanban', 'freeappstore.online', 'apps/kanban', 'apps', 'r2', 1, 1)`,
    ).run();

    expect(() => db.prepare(ROUTE_LOOKUP_SQL).get("kanban", "freeappstore.online")).toThrow(/no such column: cross_origin_isolated/);

    db.exec(sql("0002_cross_origin_isolated.sql"));
    db.exec(sql("0004_routes_release.sql"));

    const column = (db.prepare("PRAGMA table_info(routes)").all() as RouteInfo[]).find((info) => info.name === "cross_origin_isolated");
    expect(column?.notnull).toBe(1);
    expect(Number(column?.dflt_value)).toBe(0);

    const existing = db.prepare(ROUTE_LOOKUP_SQL).get("kanban", "freeappstore.online") as RouteRow;
    expect(existing.r2_prefix).toBe("apps/kanban");
    expect(existing.cross_origin_isolated).toBe(0);
    expect(wantsCrossOriginIsolation(existing)).toBe(false);

    db.prepare(
      `INSERT INTO routes (slug, zone, r2_prefix, store, hosted_on, created_at, updated_at)
       VALUES ('dict', 'freeappstore.online', 'apps/dict', 'apps', 'r2', 2, 2)`,
    ).run();
    db.prepare(
      `INSERT INTO routes (slug, zone, r2_prefix, store, hosted_on, created_at, updated_at, cross_origin_isolated)
       VALUES ('wasm', 'freeappstore.online', 'apps/wasm', 'apps', 'r2', 3, 3, 1)`,
    ).run();

    const inserted = db.prepare(ROUTE_LOOKUP_SQL).get("dict", "freeappstore.online") as RouteRow;
    const optedIn = db.prepare(ROUTE_LOOKUP_SQL).get("wasm", "freeappstore.online") as RouteRow;
    expect(wantsCrossOriginIsolation(inserted)).toBe(false);
    expect(optedIn.cross_origin_isolated).toBe(1);
    expect(wantsCrossOriginIsolation(optedIn)).toBe(true);
    expect(wantsCrossOriginIsolation(db.prepare(ROUTE_LOOKUP_SQL).get("kanban", "freeappstore.online") as RouteRow)).toBe(false);
  });
});
