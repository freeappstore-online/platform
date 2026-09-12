import { describe, expect, it } from "vitest";
import { type CfFn, type DeprovisionEnv, deleteHostRoute, deleteRepo, handleDeprovision, removeRegistryEntry } from "./deprovision";
import { type GhFn, STORE_CONFIG } from "./publish";

const config = STORE_CONFIG.apps;

interface StmtCapture {
  sql: string;
  binds: unknown[];
}

function fakeDB(opts?: { shouldThrow?: boolean; capture?: StmtCapture[] }) {
  const makeStmt = (sql: string) => {
    const stmt: StmtCapture & { bind: (...a: unknown[]) => unknown } = {
      sql: sql.replace(/\s+/g, " ").trim(),
      binds: [],
      bind: (...args: unknown[]) => {
        stmt.binds = args;
        return stmt;
      },
    };
    return stmt;
  };
  return {
    prepare: (sql: string) => makeStmt(sql),
    batch: async (stmts: StmtCapture[]) => {
      if (opts?.shouldThrow) throw new Error("D1 constraint error");
      opts?.capture?.push(...stmts.map((s) => ({ sql: s.sql, binds: s.binds })));
      return stmts.map(() => ({ meta: { changes: 1 } }));
    },
  } as unknown as D1Database;
}

function fakeR2(keys: string[]) {
  const deleted: string[] = [];
  return {
    deleted,
    bucket: {
      list: async () => ({ objects: keys.map((key) => ({ key })), truncated: false }),
      delete: async (ks: string[]) => {
        deleted.push(...ks);
      },
    } as unknown as R2Bucket,
  };
}

function baseEnv(overrides?: Partial<DeprovisionEnv>): DeprovisionEnv {
  return {
    CF_ACCOUNT_ID: "acc",
    CF_API_TOKEN: "cf",
    GITHUB_TOKEN: "gh",
    FAS_ZONE_ID: "zone-fas",
    FGS_ZONE_ID: "zone-fgs",
    DB: fakeDB(),
    BACKEND_FAS: undefined,
    ADMIN_PROVISION_TOKEN: undefined,
    ...overrides,
  };
}

function registryFile(apps: { id: string }[]) {
  return { content: btoa(JSON.stringify({ apps })), sha: "sha1" };
}

/** GitHub mock: serves registry.json, records PUTs and DELETEs. */
function fakeGh(opts: { apps: { id: string }[]; putStatus?: number[]; deleteStatus?: number }) {
  const puts: any[] = [];
  const deletes: string[] = [];
  const putStatuses = [...(opts.putStatus ?? [200])];
  const gh: GhFn = async (path, method = "GET", body) => {
    if (path.endsWith("/contents/registry.json") && method === "GET") return registryFile(opts.apps);
    if (path.endsWith("/contents/registry.json") && method === "PUT") {
      puts.push(body);
      const status = putStatuses.shift() ?? 200;
      return status === 200 ? { content: {}, __status: 200 } : { message: "conflict", __status: status };
    }
    if (method === "DELETE") {
      deletes.push(path);
      const status = opts.deleteStatus ?? 204;
      return status === 204 ? { __status: 204, __empty: true } : { __status: status, message: `status ${status}` };
    }
    throw new Error(`unexpected gh call ${method} ${path}`);
  };
  return { gh, puts, deletes };
}

const noDns: CfFn = async () => ({ result: [] });

describe("removeRegistryEntry", () => {
  it("removes the entry and PUTs the rest back", async () => {
    const { gh, puts } = fakeGh({ apps: [{ id: "keep" }, { id: "gone" }] });
    const step = await removeRegistryEntry(gh, "gone", config);
    expect(step.status).toBe("ok");
    expect(puts).toHaveLength(1);
    const written = JSON.parse(atob(puts[0].content));
    expect(written.apps.map((a: any) => a.id)).toEqual(["keep"]);
    expect(puts[0].sha).toBe("sha1");
  });

  it("skips when the id is not listed", async () => {
    const { gh, puts } = fakeGh({ apps: [{ id: "keep" }] });
    const step = await removeRegistryEntry(gh, "gone", config);
    expect(step.status).toBe("skip");
    expect(puts).toHaveLength(0);
  });

  it("fails when registry.json cannot be read", async () => {
    const gh: GhFn = async () => ({ message: "Not Found", __status: 404 });
    const step = await removeRegistryEntry(gh, "gone", config);
    expect(step.status).toBe("fail");
  });

  it("retries once on 409", async () => {
    const { gh, puts } = fakeGh({ apps: [{ id: "gone" }], putStatus: [409, 200] });
    const step = await removeRegistryEntry(gh, "gone", config);
    expect(step.status).toBe("ok");
    expect(puts).toHaveLength(2);
  });
});

describe("deleteHostRoute", () => {
  it("deletes the routes row AND the apps ownership row in one batch", async () => {
    const capture: StmtCapture[] = [];
    const step = await deleteHostRoute(baseEnv({ DB: fakeDB({ capture }) }), "kanban", config);
    expect(step.status).toBe("ok");
    expect(capture).toHaveLength(2);
    expect(capture[0].sql).toMatch(/^DELETE FROM routes WHERE slug = \?1 AND zone = \?2$/);
    expect(capture[0].binds).toEqual(["kanban", "freeappstore.online"]);
    expect(capture[1].sql).toMatch(/^DELETE FROM apps WHERE id = \?1$/);
    expect(capture[1].binds).toEqual(["kanban"]);
  });

  it("fails without a DB binding", async () => {
    const step = await deleteHostRoute(baseEnv({ DB: undefined }), "kanban", config);
    expect(step.status).toBe("fail");
  });

  it("fails when D1 throws", async () => {
    const step = await deleteHostRoute(baseEnv({ DB: fakeDB({ shouldThrow: true }) }), "kanban", config);
    expect(step.status).toBe("fail");
    expect(step.detail).toContain("D1 constraint error");
  });
});

describe("deleteRepo", () => {
  it("ok on 204", async () => {
    const { gh, deletes } = fakeGh({ apps: [] });
    const step = await deleteRepo(gh, "kanban", config);
    expect(step.status).toBe("ok");
    expect(deletes).toEqual(["/repos/freeappstore-online/kanban"]);
  });

  it("ok on 404 (already gone)", async () => {
    const { gh } = fakeGh({ apps: [], deleteStatus: 404 });
    expect((await deleteRepo(gh, "kanban", config)).status).toBe("ok");
  });

  it("names the missing token permission on 403", async () => {
    const { gh } = fakeGh({ apps: [], deleteStatus: 403 });
    const step = await deleteRepo(gh, "kanban", config);
    expect(step.status).toBe("fail");
    expect(step.detail).toContain("delete_repo");
  });
});

describe("handleDeprovision", () => {
  it("runs every step and purges R2 for a full unpublish", async () => {
    const { gh, deletes } = fakeGh({ apps: [{ id: "kanban" }] });
    const r2 = fakeR2(["apps/kanban/index.html", "apps/kanban/a.js"]);
    const cfCalls: string[] = [];
    const cf: CfFn = async (path, method = "GET") => {
      cfCalls.push(`${method} ${path}`);
      return method === "GET" ? { result: [{ id: "dns1" }] } : { success: true };
    };
    const result = await handleDeprovision({ id: "kanban", store: "apps", deleteRepo: true }, baseEnv({ APPS: r2.bucket }), { gh, cf });
    expect(result.ok).toBe(true);
    expect(result.steps.map((s) => `${s.name}:${s.status}`)).toEqual([
      "registry:ok",
      "hosting_route:ok",
      "r2_objects:ok",
      "dns:ok",
      "delete_repo:ok",
    ]);
    expect(r2.deleted).toEqual(["apps/kanban/index.html", "apps/kanban/a.js"]);
    expect(cfCalls).toEqual([
      "GET /zones/zone-fas/dns_records?type=CNAME&name=kanban.freeappstore.online",
      "DELETE /zones/zone-fas/dns_records/dns1",
    ]);
    expect(deletes).toEqual(["/repos/freeappstore-online/kanban"]);
  });

  it("skips the repo step unless deleteRepo is set", async () => {
    const { gh, deletes } = fakeGh({ apps: [] });
    const result = await handleDeprovision({ id: "kanban", store: "apps" }, baseEnv(), { gh, cf: noDns });
    expect(result.ok).toBe(true);
    expect(result.steps.some((s) => s.name === "delete_repo")).toBe(false);
    expect(deletes).toHaveLength(0);
  });

  it("still runs the other steps, and reports not ok, when repo deletion is forbidden", async () => {
    const { gh } = fakeGh({ apps: [{ id: "kanban" }], deleteStatus: 403 });
    const capture: StmtCapture[] = [];
    const result = await handleDeprovision({ id: "kanban", store: "apps", deleteRepo: true }, baseEnv({ DB: fakeDB({ capture }) }), {
      gh,
      cf: noDns,
    });
    expect(result.ok).toBe(false);
    expect(capture).toHaveLength(2);
    expect(result.steps.find((s) => s.name === "delete_repo")?.status).toBe("fail");
    expect(result.steps.find((s) => s.name === "registry")?.status).toBe("ok");
  });

  it("rejects an unsupported store", async () => {
    const result = await handleDeprovision({ id: "kanban", store: "games" as any }, baseEnv(), { gh: fakeGh({ apps: [] }).gh, cf: noDns });
    expect(result.ok).toBe(false);
    expect(result.steps[0].name).toBe("validation");
  });
});
