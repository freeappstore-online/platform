// Tests for the routes-table insert. The D1 binding is mocked here because
// vitest doesn't ship a D1 fixture; the live SQL is exercised by the
// migration apply step + end-to-end pilot.

import { describe, expect, it, vi } from "vitest";
import { insertHostRoute } from "../publish";

const config = {
  org: "freeappstore-online",
  domain: "freeappstore.online",
  storeRepo: "freeappstore",
  registryKey: "apps",
  developer: "FreeAppStore",
  templateRepo: "template-standalone",
  zoneIdFromEnv: () => "zone-id",
};

const req = {
  id: "calendar",
  name: "Calendar",
  category: "productivity",
  icon: "&#128197;",
  iconBg: "#eff6ff",
  description: "A calendar.",
  store: "apps" as const,
};

// Minimal D1Database stub — captures the SQL and bound params so tests can
// assert on the query shape without standing up a real D1. insertHostRoute now
// writes the routes row AND the apps row in a single batch(), so the stub
// records each prepared statement (sql + binds) and exposes a batch() that the
// tests can assert against.
function mockDb(opts: { fail?: boolean } = {}) {
  const prepared: Array<{ sql: string; binds: unknown[] }> = [];
  const prepare = vi.fn().mockImplementation((sql: string) => {
    const stmt: { sql: string; binds: unknown[]; bind: (...a: unknown[]) => unknown } = {
      sql,
      binds: [],
      bind(...a: unknown[]) {
        stmt.binds = a;
        return stmt;
      },
    };
    prepared.push(stmt);
    return stmt;
  });
  const batch = opts.fail
    ? vi.fn().mockRejectedValue(new Error("D1 unreachable"))
    : vi.fn().mockResolvedValue([{ success: true }, { success: true }]);
  return { db: { prepare, batch } as any, prepare, batch, prepared };
}

const env = (db: any) =>
  ({
    CF_ACCOUNT_ID: "x",
    CF_API_TOKEN: "x",
    GITHUB_TOKEN: "x",
    FAS_ZONE_ID: "x",
    FGS_ZONE_ID: "x",
    DB: db,
  }) as any;

describe("insertHostRoute", () => {
  it("returns ok with the resolved r2 prefix on success", async () => {
    const { db, batch, prepared } = mockDb();
    const step = await insertHostRoute(env(db), req, config);
    expect(step.status).toBe("ok");
    expect(step.detail).toContain("calendar.freeappstore.online");
    expect(step.detail).toContain("apps/calendar");
    // Both rows go through a single batch() — that atomicity is the point.
    expect(batch).toHaveBeenCalledTimes(1);
    expect(batch.mock.calls[0][0]).toHaveLength(2);
    // routes row shape matches what the host worker reads.
    const routes = prepared.find((s) => /INSERT\s+INTO\s+routes/.test(s.sql))!;
    expect(routes.binds.slice(0, 4)).toEqual(["calendar", "freeappstore.online", "apps/calendar", "apps"]);
    expect(typeof routes.binds[4]).toBe("number");
  });

  it("uses the store's registryKey as the r2 prefix root", async () => {
    const { db, prepared } = mockDb();
    const gamesConfig = { ...config, registryKey: "games", domain: "freegamestore.online" };
    await insertHostRoute(env(db), { ...req, store: "games" as any }, gamesConfig);
    const routes = prepared.find((s) => /INSERT\s+INTO\s+routes/.test(s.sql))!;
    expect(routes.binds[2]).toBe("games/calendar");
    expect(routes.binds[1]).toBe("freegamestore.online");
  });

  it("returns fail when D1 throws", async () => {
    const { db } = mockDb({ fail: true });
    const step = await insertHostRoute(env(db), req, config);
    expect(step.status).toBe("fail");
    expect(step.detail).toContain("D1 unreachable");
  });

  it("writes routes (upsert) + apps (insert-or-ignore) in the same batch", async () => {
    const { db, prepared } = mockDb();
    await insertHostRoute(env(db), req, config);
    const routesSql = prepared.find((s) => /INSERT\s+INTO\s+routes/.test(s.sql))!.sql;
    expect(routesSql).toMatch(/ON\s+CONFLICT\s*\(\s*slug\s*,\s*zone\s*\)\s+DO\s+UPDATE/);
    const appsSql = prepared.find((s) => /INSERT\s+OR\s+IGNORE\s+INTO\s+apps/.test(s.sql))!.sql;
    expect(appsSql).toBeDefined();
  });
});
