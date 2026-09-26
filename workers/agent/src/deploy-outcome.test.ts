// #11: deploy and push_update report the real CI outcome (live, a concrete
// build failure with fix instructions, or still building) instead of a vague
// success, and check_deploy_status moves the session out of "building" once CI
// finishes. The GitHub-facing functions in deploy.ts are mocked; everything in
// infra-exec.ts is real.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getConfig } from "./config";
import { type DeployStatus, deployApp, pushUpdate, readDeployRun, waitForGitHubDeploy } from "./deploy";
import { executeInfraTool } from "./infra-exec";

vi.mock("./deploy", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./deploy")>();
  return { ...actual, deployApp: vi.fn(), pushUpdate: vi.fn(), waitForGitHubDeploy: vi.fn(), readDeployRun: vi.fn() };
});

const deployMock = vi.mocked(deployApp);
const pushMock = vi.mocked(pushUpdate);
const waitMock = vi.mocked(waitForGitHubDeploy);
const readMock = vi.mocked(readDeployRun);

const APP_URL = "https://dict.freeappstore.online";
const BUILD_ERROR =
  "Build failed at build › Build web (run 7)\nsrc/App.tsx(3,7): error TS2322: Type 'string' is not assignable to type 'number'.";

/** D1 stand-in: `apps` ownership plus a record of every statement run. */
function makeDb(apps: Map<string, string>) {
  const ran: string[] = [];
  const db = {
    prepare(sql: string) {
      return {
        bind(...args: unknown[]) {
          return {
            async first<T>(): Promise<T | null> {
              const owner = sql.includes("SELECT owner_login FROM apps") ? apps.get(args[0] as string) : undefined;
              return owner ? ({ owner_login: owner } as T) : null;
            },
            async run() {
              ran.push(sql);
              if (sql.includes("INSERT INTO apps") && !apps.has(args[0] as string)) apps.set(args[0] as string, args[1] as string);
              if (sql.includes("DELETE FROM apps") && apps.get(args[0] as string) === args[1]) apps.delete(args[0] as string);
              return { success: true };
            },
          };
        },
      };
    },
  };
  return { db, ran };
}

function makeCtx(overrides: { appId?: string | null; deployStatus?: DeployStatus | null } = {}) {
  const apps = new Map<string, string>();
  const { db, ran } = makeDb(apps);
  const published: string[] = [];
  const PLATFORM = {
    fetch: vi.fn(async (_url: string, init: RequestInit) => {
      published.push(String(init.body));
      return new Response("{}", { status: 200 });
    }),
  };
  const statuses: DeployStatus[] = [];
  const ctx = {
    appId: overrides.appId ?? null,
    ownerLogin: "alice",
    authHeader: "Bearer tok",
    files: new Map<string, string>(),
    env: { GITHUB_TOKEN: "gh", DB: db as never, PLATFORM: PLATFORM as never },
    config: getConfig("apps"),
    deployStatus: overrides.deployStatus ?? null,
    onDeployStatus: vi.fn(async (s: DeployStatus) => {
      statuses.push(s);
    }),
    onAppDeployed: vi.fn(),
  };
  return { ctx, apps, ran, published, statuses };
}

const deployCall = {
  id: "t1",
  name: "deploy",
  input: { id: "dict", name: "Dict", category: "learning", icon: "x", iconBg: "#fff", description: "A dictionary" },
};
const pushCall = { id: "t2", name: "push_update", input: { id: "dict", message: "fix" } };

/** Make deployApp report `statuses` through onStatus, as the real one does. */
function deployReports(...statuses: DeployStatus[]) {
  deployMock.mockImplementation(async (_cfg, _files, _env, _config, onStatus) => {
    for (const status of statuses) await onStatus(status);
  });
}

const originalFetch = globalThis.fetch;
beforeEach(() => {
  vi.resetAllMocks();
  // repoExists: the id is free.
  globalThis.fetch = vi.fn(async () => new Response("{}", { status: 404 })) as typeof fetch;
});
afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe("deploy reports the CI outcome (#11)", () => {
  it("successful deploy: says live only once CI reached live", async () => {
    deployReports({ phase: "building", deployUrl: APP_URL }, { phase: "live", appUrl: APP_URL });
    const { ctx } = makeCtx();

    const result = await executeInfraTool(deployCall, ctx);

    expect(result).toBe(`Deploy succeeded. Live: ${APP_URL}. Store listing published.`);
  });

  it("terminal error deploy: fails with the build reason and fix instructions, keeps the app provisioned", async () => {
    deployReports({ phase: "building", deployUrl: APP_URL }, { phase: "error", error: BUILD_ERROR });
    const { ctx, apps, ran, published, statuses } = makeCtx();

    const result = await executeInfraTool(deployCall, ctx);

    expect(result).toMatch(/^Deploy FAILED: the code was pushed but the build broke\./);
    expect(result).toContain("error TS2322");
    expect(result).toContain("Use get_build_logs to see the full log, fix the code, then push_update.");
    // The code is on GitHub, so ownership, route and listing stay: a push_update fix goes live without another deploy.
    expect(apps.get("dict")).toBe("alice");
    expect(ran.some((sql) => sql.includes("INSERT INTO routes"))).toBe(true);
    expect(published).toHaveLength(1);
    // The error was reported once, by the build, not repeated by the tool.
    expect(statuses.filter((s) => s.phase === "error")).toHaveLength(1);
  });

  it("poll timeout: says CI is still building, never live, and never reads as a failure", async () => {
    deployReports({ phase: "building", deployUrl: APP_URL });
    const { ctx, statuses } = makeCtx();

    const result = await executeInfraTool(deployCall, ctx);

    expect(result).toMatch(/^Deploy pushed\. CI is still building/);
    expect(result).toContain("check_deploy_status");
    // The session's follow-up prompt treats /error|fail|threw/ as a broken action.
    expect(result).not.toMatch(/error|fail|threw/i);
    expect(statuses.some((s) => s.phase === "live")).toBe(false);
  });

  it("failure before the code was pushed stops there and releases the claim", async () => {
    deployReports({ phase: "error", error: "GitHub repo creation failed: 422" });
    const { ctx, apps, ran } = makeCtx();

    const result = await executeInfraTool(deployCall, ctx);

    expect(result).toBe("Deploy FAILED: GitHub repo creation failed: 422");
    expect(apps.has("dict")).toBe(false);
    expect(ran.some((sql) => sql.includes("INSERT INTO routes"))).toBe(false);
  });
});

describe("push_update reports the CI outcome (#11)", () => {
  beforeEach(() => {
    pushMock.mockResolvedValue({ ok: true, message: "Pushed update to freeappstore-online/dict (abc1234): 1 file.", commitSha: "abc1234" });
  });

  it("successful update: live", async () => {
    waitMock.mockResolvedValue({ phase: "live", appUrl: APP_URL });
    const { ctx } = makeCtx({ appId: "dict" });

    const result = await executeInfraTool(pushCall, ctx);

    expect(result).toContain(`Update deployed and LIVE at ${APP_URL}.`);
    expect(waitMock).toHaveBeenCalledWith("dict", ctx.env, ctx.config, ctx.onDeployStatus, "abc1234");
  });

  it("failed update: the build reason and fix instructions", async () => {
    waitMock.mockResolvedValue({ phase: "error", error: BUILD_ERROR });
    const { ctx } = makeCtx({ appId: "dict" });

    const result = await executeInfraTool(pushCall, ctx);

    expect(result).toMatch(/^Update pushed but the build FAILED:/);
    expect(result).toContain("error TS2322");
    expect(result).toContain("Use get_build_logs to see the full log, fix the code, then push_update.");
  });

  it("poll timeout: still building, not a failure", async () => {
    waitMock.mockResolvedValue(null);
    const { ctx } = makeCtx({ appId: "dict" });

    const result = await executeInfraTool(pushCall, ctx);

    expect(result).toContain("CI is still building");
    expect(result).not.toMatch(/error|fail|threw/i);
  });
});

describe("check_deploy_status settles a build that finished after the wait (#11)", () => {
  const checkCall = { id: "t3", name: "check_deploy_status", input: { id: "dict" } };

  it("moves a session stuck on building to live", async () => {
    readMock.mockResolvedValue({ phase: "live", appUrl: APP_URL });
    const { ctx, statuses } = makeCtx({ appId: "dict", deployStatus: { phase: "building", deployUrl: APP_URL } });

    const result = await executeInfraTool(checkCall, ctx);

    expect(statuses).toEqual([{ phase: "live", appUrl: APP_URL }]);
    expect(result).toBe(`Latest deploy: live at ${APP_URL}`);
  });

  it("reports a late failure once, with fix instructions", async () => {
    readMock.mockResolvedValue({ phase: "error", error: BUILD_ERROR });
    const { ctx, statuses } = makeCtx({ appId: "dict", deployStatus: { phase: "building", deployUrl: APP_URL } });

    const result = await executeInfraTool(checkCall, ctx);

    expect(statuses).toEqual([{ phase: "error", error: BUILD_ERROR }]);
    expect(result).toContain("error TS2322");
    expect(result).toContain("push_update");

    // Polling again: same failure, nothing new to record.
    const again = makeCtx({ appId: "dict", deployStatus: { phase: "error", error: BUILD_ERROR } });
    await executeInfraTool(checkCall, again.ctx);
    expect(again.statuses).toEqual([]);
  });
});
