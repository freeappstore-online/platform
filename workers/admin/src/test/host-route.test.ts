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
// assert on the query shape without standing up a real D1.
function mockDb(opts: { fail?: boolean } = {}) {
  const run = opts.fail ? vi.fn().mockRejectedValue(new Error("D1 unreachable")) : vi.fn().mockResolvedValue({ success: true });
  const bind = vi.fn().mockReturnValue({ run });
  const prepare = vi.fn().mockReturnValue({ bind });
  return { db: { prepare } as any, prepare, bind, run };
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
    const { db, bind } = mockDb();
    const step = await insertHostRoute(env(db), req, config);
    expect(step.status).toBe("ok");
    expect(step.detail).toContain("calendar.freeappstore.online");
    expect(step.detail).toContain("apps/calendar");
    // Confirms the row shape matches what the host worker reads.
    const args = bind.mock.calls[0];
    expect(args.slice(0, 4)).toEqual(["calendar", "freeappstore.online", "apps/calendar", "apps"]);
    expect(typeof args[4]).toBe("number");
  });

  it("uses the store's registryKey as the r2 prefix root", async () => {
    const { db, bind } = mockDb();
    const gamesConfig = { ...config, registryKey: "games", domain: "freegamestore.online" };
    await insertHostRoute(env(db), { ...req, store: "games" as any }, gamesConfig);
    expect(bind.mock.calls[0][2]).toBe("games/calendar");
    expect(bind.mock.calls[0][1]).toBe("freegamestore.online");
  });

  it("returns fail when D1 throws", async () => {
    const { db } = mockDb({ fail: true });
    const step = await insertHostRoute(env(db), req, config);
    expect(step.status).toBe("fail");
    expect(step.detail).toContain("D1 unreachable");
  });

  it("uses INSERT ... ON CONFLICT for idempotent re-publish", async () => {
    const { db, prepare } = mockDb();
    await insertHostRoute(env(db), req, config);
    const sql = prepare.mock.calls[0][0];
    expect(sql).toMatch(/INSERT\s+INTO\s+routes/);
    expect(sql).toMatch(/ON\s+CONFLICT\s*\(\s*slug\s*,\s*zone\s*\)\s+DO\s+UPDATE/);
  });
});
