import { describe, expect, it } from "vitest";
import { type GhFn, handlePublish, insertHostRoute, writeRegistryWithRetry } from "./publish";

// ── Helpers ──

function fakeDB(opts?: { shouldThrow?: boolean }) {
  return {
    prepare: () => ({
      bind: () => ({
        run: async () => {
          if (opts?.shouldThrow) throw new Error("D1 constraint error");
          return { meta: { changes: 1 } };
        },
      }),
    }),
  } as unknown as D1Database;
}

function baseEnv(overrides?: Record<string, unknown>) {
  return {
    CF_ACCOUNT_ID: "acc123",
    CF_API_TOKEN: "cftoken",
    GITHUB_TOKEN: "ghtoken",
    FAS_ZONE_ID: "zone1",
    FGS_ZONE_ID: "zone2",
    DB: fakeDB(),
    ...overrides,
  };
}

function baseReq(overrides?: Record<string, unknown>) {
  return {
    id: "testapp",
    name: "Test App",
    category: "utilities",
    icon: "📱",
    iconBg: "#f0f9ff",
    description: "A test app",
    store: "apps" as const,
    creatorGithub: "testuser",
    ...overrides,
  };
}

/** Mock GH API that returns success for all calls */
function successGh(): GhFn {
  return async (path, method) => {
    if (method === "PUT" && path.includes("registry.json")) {
      return { content: { sha: "newsha" } };
    }
    if (path.includes("registry.json")) {
      // GET registry — return valid registry with no existing entry
      const content = btoa(JSON.stringify({ apps: [], games: [] }));
      return { content, sha: "abc123" };
    }
    if (path.includes("/repos/") && !method) {
      // GET repo check — repo exists
      return { id: 12345 };
    }
    if (method === "PUT" && path.includes("/collaborators/")) {
      return { __status: 204, __empty: true };
    }
    if (method === "POST" && path.includes("/repos")) {
      return { id: 99 };
    }
    return { __status: 200 };
  };
}

// ── insertHostRoute ──

describe("insertHostRoute", () => {
  it("returns ok when DB insert succeeds", async () => {
    const env = baseEnv();
    const req = baseReq();
    const config = { domain: "freeappstore.online", registryKey: "apps" } as any;
    const result = await insertHostRoute(env, req, config);
    expect(result.status).toBe("ok");
    expect(result.detail).toContain("testapp.freeappstore.online");
    expect(result.detail).toContain("apps/testapp");
  });

  it("returns fail when DB is undefined", async () => {
    const env = baseEnv({ DB: undefined });
    const req = baseReq();
    const config = { domain: "freeappstore.online", registryKey: "apps" } as any;
    const result = await insertHostRoute(env, req, config);
    expect(result.status).toBe("fail");
    expect(result.detail).toContain("D1 binding not available");
  });

  it("returns fail when DB throws", async () => {
    const env = baseEnv({ DB: fakeDB({ shouldThrow: true }) });
    const req = baseReq();
    const config = { domain: "freeappstore.online", registryKey: "apps" } as any;
    const result = await insertHostRoute(env, req, config);
    expect(result.status).toBe("fail");
    expect(result.detail).toContain("D1 constraint error");
  });
});

// ── writeRegistryWithRetry ──

describe("writeRegistryWithRetry", () => {
  it("adds entry to registry on success", async () => {
    const gh = successGh();
    const req = baseReq();
    const config = { org: "freeappstore-online", storeRepo: "freeappstore", registryKey: "apps", domain: "freeappstore.online" } as any;
    const result = await writeRegistryWithRetry(gh, req, config, "testapp.freeappstore.online");
    expect(result.status).toBe("ok");
    expect(result.detail).toContain("Test App");
  });

  it("skips when entry already exists", async () => {
    const gh: GhFn = async (path) => {
      if (path.includes("registry.json") && !path.includes("PUT")) {
        const content = btoa(JSON.stringify({ apps: [{ id: "testapp" }] }));
        return { content, sha: "abc" };
      }
      return { __status: 200 };
    };
    const req = baseReq();
    const config = { org: "freeappstore-online", storeRepo: "freeappstore", registryKey: "apps", domain: "freeappstore.online" } as any;
    const result = await writeRegistryWithRetry(gh, req, config, "testapp.freeappstore.online");
    expect(result.status).toBe("skip");
    expect(result.detail).toContain("Already listed");
  });

  it("retries once on 409 conflict", async () => {
    let callCount = 0;
    const gh: GhFn = async (path, method) => {
      if (path.includes("registry.json")) {
        if (method === "PUT") {
          callCount++;
          if (callCount === 1) return { __status: 409 };
          return { content: { sha: "new" } };
        }
        const content = btoa(JSON.stringify({ apps: [] }));
        return { content, sha: `sha${callCount}` };
      }
      return { __status: 200 };
    };
    const req = baseReq();
    const config = { org: "freeappstore-online", storeRepo: "freeappstore", registryKey: "apps", domain: "freeappstore.online" } as any;
    const result = await writeRegistryWithRetry(gh, req, config, "testapp.freeappstore.online");
    expect(result.status).toBe("ok");
    expect(callCount).toBe(2);
  });
});

// ── handlePublish ──

describe("handlePublish", () => {
  it("rejects missing id", async () => {
    const result = await handlePublish(baseReq({ id: "" }), baseEnv(), successGh());
    expect(result.success).toBe(false);
    expect(result.steps[0]?.name).toBe("Validation");
  });

  it("rejects invalid store", async () => {
    const result = await handlePublish(baseReq({ store: "invalid" as any }), baseEnv(), successGh());
    expect(result.success).toBe(false);
    expect(result.steps[0]?.detail).toContain("store must be one of");
  });

  it("rejects ID starting with free/pro", async () => {
    const result = await handlePublish(baseReq({ id: "freeapp" }), baseEnv(), successGh());
    expect(result.success).toBe(false);
    expect(result.steps[0]?.detail).toContain("free");
  });

  it("rejects IDs with uppercase", async () => {
    const result = await handlePublish(baseReq({ id: "BadApp" }), baseEnv(), successGh());
    expect(result.success).toBe(false);
  });

  it("succeeds end-to-end with all steps passing", async () => {
    const result = await handlePublish(baseReq(), baseEnv(), successGh());
    expect(result.success).toBe(true);
    const stepNames = result.steps.map((s) => s.name);
    expect(stepNames).toContain("GitHub repo");
    expect(stepNames).toContain("Collaborator");
    expect(stepNames).toContain("Hosting route");
    expect(stepNames).toContain("Store registry");
  });

  it("skips registry when hosting route fails (no DB)", async () => {
    const result = await handlePublish(baseReq(), baseEnv({ DB: undefined }), successGh());
    expect(result.success).toBe(false);
    const hostStep = result.steps.find((s) => s.name === "Hosting route");
    expect(hostStep?.status).toBe("fail");
    const regStep = result.steps.find((s) => s.name === "Store registry");
    expect(regStep?.status).toBe("skip");
    expect(regStep?.detail).toContain("hosting route insert failed");
  });

  it("creates new repo when it does not exist", async () => {
    let repoCreated = false;
    const gh: GhFn = async (path, method, body) => {
      if (path.includes("/repos/freeappstore-online/testapp") && !method) {
        return { __status: 404 }; // repo doesn't exist
      }
      if (method === "POST" && path.includes("/repos")) {
        repoCreated = true;
        return { id: 99 };
      }
      if (method === "PUT" && path.includes("/collaborators/")) {
        return { __status: 204, __empty: true };
      }
      if (path.includes("registry.json") && method === "PUT") {
        return { content: { sha: "new" } };
      }
      if (path.includes("registry.json")) {
        return { content: btoa(JSON.stringify({ apps: [] })), sha: "abc" };
      }
      return { __status: 200 };
    };
    const result = await handlePublish(baseReq(), baseEnv(), gh);
    expect(result.success).toBe(true);
    expect(repoCreated).toBe(true);
  });

  it("fails early when repo creation fails", async () => {
    const gh: GhFn = async (path, method) => {
      if (path.includes("/repos/freeappstore-online/testapp") && !method) {
        return { __status: 404 };
      }
      if (method === "POST" && path.includes("/repos")) {
        return { message: "Validation Failed" };
      }
      return { __status: 200 };
    };
    const result = await handlePublish(baseReq(), baseEnv(), gh);
    expect(result.success).toBe(false);
    expect(result.steps).toHaveLength(1);
    expect(result.steps[0]?.name).toBe("GitHub repo");
    expect(result.steps[0]?.status).toBe("fail");
  });

  it("rejects games store (moved to freegamestore-admin)", async () => {
    const result = await handlePublish(baseReq({ store: "games" as never }), baseEnv(), successGh());
    expect(result.success).toBe(false);
    expect(result.steps[0]?.name).toBe("Validation");
    expect(result.steps[0]?.detail).toContain("store must be one of");
  });
});
