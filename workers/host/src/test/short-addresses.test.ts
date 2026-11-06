import { afterEach, expect, it, vi } from "vitest";
import { ROUTE_LOOKUP_SQL } from "../host";

afterEach(() => vi.unstubAllGlobals());

it("shares deployed assets and preserves old routes without taking over occupied names", async () => {
  const nodeModule = <T>(name: string) => import(/* @vite-ignore */ name) as Promise<T>;
  const { DatabaseSync } = await nodeModule<{
    DatabaseSync: new (
      path: string,
    ) => {
      exec(sql: string): void;
      prepare(sql: string): { get(...args: string[]): unknown };
      close(): void;
    };
  }>("node:sqlite");
  const { readFileSync } = await nodeModule<{ readFileSync(path: URL, encoding: string): string }>("node:fs");
  const sql = (name: string) => readFileSync(new URL(`../../migrations/${name}`, (import.meta as unknown as { url: string }).url), "utf8");
  const db = new DatabaseSync(":memory:");
  try {
    db.exec(sql("0001_create_routes.sql"));
    db.exec(sql("0002_cross_origin_isolated.sql"));
    db.exec(
      "INSERT INTO routes VALUES ('hanzi-practice', 'freeappstore.online', 'apps/hanzi-practice', 'apps', 'r2', 1, 1, 0), ('hanzi-associations', 'freeappstore.online', 'apps/hanzi-associations', 'apps', 'r2', 1, 1, 0)",
    );
    db.exec(sql("0003_hanzi_short_addresses.sql"));
    db.exec(sql("0004_routes_release.sql"));
    for (const [short, original] of [
      ["hanzi", "hanzi-practice"],
      ["yi", "hanzi-associations"],
    ]) {
      expect(db.prepare(ROUTE_LOOKUP_SQL).get(short, "freeappstore.online")).toMatchObject({ r2_prefix: `apps/${original}` });
      expect(db.prepare(ROUTE_LOOKUP_SQL).get(original, "freeappstore.online")).toMatchObject({ r2_prefix: `apps/${original}` });
    }
    expect(() => db.exec(sql("0003_hanzi_short_addresses.sql"))).toThrow(/UNIQUE/);
  } finally {
    db.close();
  }
});

it("uses listing metadata for its declared short address only when the asset prefix agrees", async () => {
  vi.resetModules();
  vi.stubGlobal(
    "fetch",
    vi.fn().mockResolvedValue(
      Response.json({
        apps: [
          {
            id: "hanzi-practice",
            name: "Hanzi",
            description: "Chinese character practice",
            appUrl: "https://hanzi.freeappstore.online",
          },
        ],
      }),
    ),
  );
  const { publicApp } = await import("../seo");
  const route = { slug: "hanzi", zone: "freeappstore.online", r2_prefix: "apps/hanzi-practice", store: "apps" };
  expect(await publicApp(route)).toMatchObject({ name: "Hanzi" });
  expect(await publicApp({ ...route, r2_prefix: "apps/unrelated" })).toBeUndefined();
  expect(await publicApp({ ...route, slug: "hanzi-practice" })).toBeUndefined();
});
