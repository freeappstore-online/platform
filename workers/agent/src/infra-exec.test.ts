import { describe, expect, it, vi } from "vitest";
import { getConfig } from "./config";
import type { DeployStatus } from "./deploy";
import { applyPlaceholders, executeInfraTool, INFRA_ERROR_PATTERN } from "./infra-exec";

describe("applyPlaceholders", () => {
  it("APPID -> the slug everywhere (so the SDK proxy path matches the deployed id)", () => {
    const files = new Map([["web/src/App.tsx", 'initApp({ appId: "APPID" })']]);
    applyPlaceholders(files, "weather-app", "Weather App");
    expect(files.get("web/src/App.tsx")).toBe('initApp({ appId: "weather-app" })');
  });

  it("APPNAME -> display name in code, but the slug in package.json", () => {
    const files = new Map([
      ["web/index.html", "<title>APPNAME</title>"],
      ["package.json", '{ "name": "@APPNAME/root" }'],
    ]);
    applyPlaceholders(files, "weather-app", "Weather App");
    expect(files.get("web/index.html")).toBe("<title>Weather App</title>");
    expect(files.get("package.json")).toBe('{ "name": "@weather-app/root" }');
  });

  it("leaves files without placeholders untouched", () => {
    const files = new Map([["a.ts", "const x = 1;"]]);
    applyPlaceholders(files, "id", "Name");
    expect(files.get("a.ts")).toBe("const x = 1;");
  });
});

const appsConfig = getConfig("apps");

/**
 * Minimal in-memory stand-in for the `apps`/`routes` D1 tables — enough to
 * exercise the ownership checks in executeDeploy. `apps` maps id -> owner_login.
 */
function makeDb(apps: Map<string, string>) {
  return {
    prepare(sql: string) {
      return {
        bind(...args: unknown[]) {
          return {
            async first<T>(): Promise<T | null> {
              if (sql.includes("SELECT owner_login FROM apps")) {
                const owner = apps.get(args[0] as string);
                return owner ? ({ owner_login: owner } as T) : null;
              }
              return null;
            },
            async run() {
              if (sql.includes("INSERT INTO apps")) {
                const [id, owner] = args as [string, string];
                if (!apps.has(id)) apps.set(id, owner); // ON CONFLICT DO NOTHING
              } else if (sql.includes("DELETE FROM apps")) {
                const [id, owner] = args as [string, string];
                if (apps.get(id) === owner) apps.delete(id);
              }
              return { success: true };
            },
          };
        },
      };
    },
  };
}

function makeCtx(
  overrides: Partial<{
    appId: string | null;
    ownerLogin: string | null;
    apps: Map<string, string>;
  }> = {},
) {
  return {
    appId: overrides.appId ?? null,
    ownerLogin: overrides.ownerLogin ?? null,
    files: new Map<string, string>(),
    env: {
      GITHUB_TOKEN: "test-token",
      ...(overrides.apps ? { DB: makeDb(overrides.apps) as never } : {}),
    },
    config: appsConfig,
    onDeployStatus: vi.fn() as (status: DeployStatus) => void,
    onAppDeployed: vi.fn() as (id: string, name: string) => void,
  };
}

describe("executeInfraTool — ID validation", () => {
  it("rejects invalid ID format", async () => {
    const ctx = makeCtx();
    const result = await executeInfraTool(
      {
        id: "1",
        name: "deploy",
        input: { id: "UPPERCASE", name: "Test", category: "utilities", icon: "&#128992;", iconBg: "#fff", description: "test" },
      },
      ctx,
    );
    expect(result).toContain("invalid app ID");
  });

  it("rejects ID starting with 'free'", async () => {
    const ctx = makeCtx();
    const result = await executeInfraTool(
      {
        id: "1",
        name: "deploy",
        input: { id: "freeapp", name: "Test", category: "utilities", icon: "&#128992;", iconBg: "#fff", description: "test" },
      },
      ctx,
    );
    expect(result).toContain("invalid app ID");
  });

  it("rejects ID starting with 'pro'", async () => {
    const ctx = makeCtx();
    const result = await executeInfraTool(
      {
        id: "1",
        name: "deploy",
        input: { id: "proapp", name: "Test", category: "utilities", icon: "&#128992;", iconBg: "#fff", description: "test" },
      },
      ctx,
    );
    expect(result).toContain("invalid app ID");
  });

  it("rejects deploying a different app after first deploy", async () => {
    const ctx = makeCtx({ appId: "my-app" });
    const result = await executeInfraTool(
      {
        id: "1",
        name: "deploy",
        input: { id: "other-app", name: "Other", category: "utilities", icon: "&#128992;", iconBg: "#fff", description: "test" },
      },
      ctx,
    );
    expect(result).toContain("this session already deployed");
  });

  it("rejects push_update with no prior deploy", async () => {
    const ctx = makeCtx();
    const result = await executeInfraTool({ id: "1", name: "push_update", input: { id: "some-app", message: "update" } }, ctx);
    expect(result).toContain("no app deployed yet");
  });

  it("rejects push_update to a different app", async () => {
    const ctx = makeCtx({ appId: "my-app" });
    const result = await executeInfraTool({ id: "1", name: "push_update", input: { id: "other-app", message: "update" } }, ctx);
    expect(result).toContain("you can only push_update on your own app");
  });
});

// ── #11: tool results report how CI actually ended ─────────────────────────

type RunOutcome = "success" | "failure" | "in_progress";

/**
 * A GitHub stand-in for the full deploy / push_update path: repo lookup and
 * creation, the Git Data API push, the Actions runs list, and — for a failed
 * run — the jobs list and the failed job's log. `run` decides how CI ends.
 */
function fakeGitHub(run: RunOutcome, commitSha = "abc123456789") {
  return vi.fn(async (url: string, init?: RequestInit) => {
    const method = init?.method || "GET";
    const json = (body: unknown, status = 200) => ({ ok: status < 400, status, json: async () => body }) as Response;
    if (method === "GET" && /\/repos\/freeappstore-online\/[^/]+$/.test(url)) return json({ message: "Not Found" }, 404);
    if (method === "POST" && url.endsWith("/orgs/freeappstore-online/repos")) return json({ id: 1 });
    if (method === "GET" && url.endsWith("/git/ref/heads/main")) return json({ object: { sha: "parent-sha" } });
    if (method === "POST" && url.endsWith("/git/blobs")) return json({ sha: "blob-sha" });
    if (method === "GET" && url.endsWith("/git/commits/parent-sha")) return json({ tree: { sha: "base-tree-sha" } });
    if (method === "POST" && url.endsWith("/git/trees")) return json({ sha: "tree-sha" });
    if (method === "POST" && url.endsWith("/git/commits")) return json({ sha: commitSha });
    if (method === "PATCH" && url.endsWith("/git/refs/heads/main")) return json({ ref: "refs/heads/main" });
    if (method === "GET" && url.endsWith("/actions/runs?per_page=10")) {
      const status = run === "in_progress" ? "in_progress" : "completed";
      const conclusion = run === "in_progress" ? null : run;
      return json({ workflow_runs: [{ id: 123, status, conclusion, head_sha: commitSha }] });
    }
    if (method === "GET" && url.endsWith("/actions/runs/123/jobs")) {
      return json({
        jobs: [
          {
            id: 9,
            name: "deploy",
            status: "completed",
            conclusion: "failure",
            steps: [{ name: "Build", status: "completed", conclusion: "failure" }],
          },
        ],
      });
    }
    if (url.endsWith("/actions/jobs/9/logs")) {
      return { ok: true, status: 200, text: async () => "error TS2304: Cannot find name 'Foo'." } as Response;
    }
    return json({ message: `Unexpected request: ${method} ${url}` }, 404);
  }) as typeof fetch;
}

const APP_URL = "https://my-app.freeappstore.online";
const DEPLOY_CALL = {
  id: "1",
  name: "deploy",
  input: { id: "my-app", name: "My App", category: "utilities", icon: "&#128992;", iconBg: "#fff", description: "test" },
};
const PUSH_CALL = { id: "1", name: "push_update", input: { id: "my-app", message: "update" } };

/** A context whose store listing publishes cleanly, so result text reflects only CI. */
function deployCtx(appId: string | null) {
  const ctx = makeCtx({ appId });
  ctx.files.set("web/src/App.tsx", "export default () => <div/>");
  Object.assign(ctx.env, { PLATFORM: { fetch: async () => new Response("{}", { status: 200 }) } });
  return Object.assign(ctx, { authHeader: "Bearer test" });
}

async function runWithCI(run: RunOutcome, call: typeof DEPLOY_CALL | typeof PUSH_CALL, appId: string | null, waitMs: number) {
  vi.useFakeTimers();
  const originalFetch = globalThis.fetch;
  globalThis.fetch = fakeGitHub(run);
  try {
    const ctx = deployCtx(appId);
    const resultPromise = executeInfraTool(call, ctx);
    await vi.advanceTimersByTimeAsync(waitMs);
    const result = await resultPromise;
    const phases = vi.mocked(ctx.onDeployStatus).mock.calls.map(([status]) => status.phase);
    return { result, ctx, phases };
  } finally {
    globalThis.fetch = originalFetch;
    vi.useRealTimers();
  }
}

// One poll is 8s; the wait gives up after 150s.
const ONE_POLL = 8_000;
const PAST_DEADLINE = 160_000;

describe("executeInfraTool — deploy reports the true CI outcome (#11)", () => {
  it("returns success only once the build is live", async () => {
    const { result, ctx } = await runWithCI("success", DEPLOY_CALL, null, ONE_POLL);

    expect(result).toBe(`Deploy succeeded. Preview: ${APP_URL}. Store listing published.`);
    expect(ctx.onDeployStatus).toHaveBeenCalledWith({ phase: "live", appUrl: APP_URL });
    expect(INFRA_ERROR_PATTERN.test(result)).toBe(false);
  });

  it("returns Deploy FAILED with the CI detail when the build fails", async () => {
    const { result, ctx } = await runWithCI("failure", DEPLOY_CALL, null, ONE_POLL);

    expect(result.startsWith("Deploy FAILED: ")).toBe(true);
    expect(result).toContain("Deploy failed (run 123)");
    expect(result).toContain("Cannot find name 'Foo'");
    expect(ctx.onDeployStatus).toHaveBeenCalledWith(expect.objectContaining({ phase: "error" }));
    expect(INFRA_ERROR_PATTERN.test(result)).toBe(true);
  });

  it("says CI is still building when the wait times out, and never claims live", async () => {
    const { result, phases } = await runWithCI("in_progress", DEPLOY_CALL, null, PAST_DEADLINE);

    expect(result).toContain("Deploy pushed");
    expect(result).toContain("still building");
    expect(result).toContain(APP_URL);
    expect(result).not.toContain("succeeded");
    expect(phases).not.toContain("live");
    expect(phases.at(-1)).toBe("building");
    // Not a failure either: the session must not tell the model to fix and redeploy.
    expect(INFRA_ERROR_PATTERN.test(result)).toBe(false);
  });
});

describe("executeInfraTool — push_update reports the true CI outcome (#11)", () => {
  it("returns the live URL once the update's build is live", async () => {
    const { result, ctx, phases } = await runWithCI("success", PUSH_CALL, "my-app", ONE_POLL);

    expect(result).toBe(`Update deployed and live at ${APP_URL}.`);
    expect(phases).toEqual(["pushing", "building", "live"]);
    expect(ctx.onDeployStatus).toHaveBeenCalledWith({ phase: "live", appUrl: APP_URL });
    expect(INFRA_ERROR_PATTERN.test(result)).toBe(false);
  });

  it("returns FAILED with the CI detail when the update's build fails, so the session asks for a fix", async () => {
    const { result, phases } = await runWithCI("failure", PUSH_CALL, "my-app", ONE_POLL);

    expect(result.startsWith("Update pushed but the build FAILED: ")).toBe(true);
    expect(result).toContain("Cannot find name 'Foo'");
    expect(result).toContain("Use get_build_logs, fix the issue, and push_update again.");
    expect(phases.at(-1)).toBe("error");
    expect(INFRA_ERROR_PATTERN.test(result)).toBe(true);
  });

  it("says CI is still building when the update's wait times out, and never claims live", async () => {
    const { result, phases } = await runWithCI("in_progress", PUSH_CALL, "my-app", PAST_DEADLINE);

    expect(result).toContain("Update pushed");
    expect(result).toContain("still building");
    expect(result).not.toContain("live at");
    expect(phases).not.toContain("live");
    expect(phases.at(-1)).toBe("building");
    expect(INFRA_ERROR_PATTERN.test(result)).toBe(false);
  });
});

describe("executeInfraTool — uniqueness check", () => {
  it("auto-resolves to the next available ID when the requested one is taken", async () => {
    const originalFetch = globalThis.fetch;
    // Base repo "taken-app" exists (200); the "-2" variant and any other URL is free (404).
    globalThis.fetch = vi.fn((url: string) => {
      const taken = typeof url === "string" && url.endsWith("/taken-app");
      return Promise.resolve({ status: taken ? 200 : 404, json: () => Promise.resolve(taken ? { id: 123 } : {}) });
    }) as any;

    try {
      const ctx = makeCtx();
      const result = await executeInfraTool(
        {
          id: "1",
          name: "deploy",
          input: { id: "taken-app", name: "Taken", category: "utilities", icon: "&#128992;", iconBg: "#fff", description: "test" },
        },
        ctx,
      );
      // Deploy proceeds under the free variant rather than erroring back to the model.
      expect(result).not.toContain("already taken");
      expect(ctx.onAppDeployed).toHaveBeenCalledWith("taken-app-2", "Taken");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("allows re-deploy of same session app (keeps its id rather than bumping)", async () => {
    const originalFetch = globalThis.fetch;
    const mockFetch = vi.fn().mockResolvedValue({ status: 200, json: () => Promise.resolve({ id: 123 }) }) as any;
    globalThis.fetch = mockFetch;

    try {
      const ctx = makeCtx({ appId: "my-app" });
      // This will fail at the deploy step (network), but should NOT fail at uniqueness
      const result = await executeInfraTool(
        {
          id: "1",
          name: "deploy",
          input: { id: "my-app", name: "My App", category: "utilities", icon: "&#128992;", iconBg: "#fff", description: "test" },
        },
        ctx,
      );
      // Should not contain "already taken" — it passed uniqueness and failed at actual deploy
      expect(result).not.toContain("already taken");
      expect(ctx.onAppDeployed).toHaveBeenCalledWith("my-app", "My App");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  // ── #29 regression coverage ───────────────────────────────────────────────

  it("bumps the id on a retry turn, rather than reusing another owner's app", async () => {
    const originalFetch = globalThis.fetch;
    // Every repo lookup says "exists" — the state after the first user deployed.
    globalThis.fetch = vi.fn(() => Promise.resolve({ status: 200, json: () => Promise.resolve({ id: 123 }) })) as any;

    try {
      // User A owns "asmr-boards". User B's session already set appId from a
      // failed first attempt — the exact state that used to bypass resolution.
      const apps = new Map([["asmr-boards", "BUDDY-KIWI-BERRY"]]);
      const ctx = makeCtx({ appId: "asmr-boards", ownerLogin: "SASASKIA", apps });

      await executeInfraTool(
        {
          id: "1",
          name: "deploy",
          input: { id: "asmr-boards", name: "ASMR", category: "utilities", icon: "&#128992;", iconBg: "#fff", description: "test" },
        },
        ctx,
      );

      // Never deploys under the taken id, and User A's ownership is untouched.
      expect(ctx.onAppDeployed).not.toHaveBeenCalledWith("asmr-boards", expect.anything());
      expect(apps.get("asmr-boards")).toBe("BUDDY-KIWI-BERRY");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("aborts instead of guessing when GitHub rate-limits the availability check", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn(() => Promise.resolve({ status: 429, json: () => Promise.resolve({}) })) as any;

    try {
      const ctx = makeCtx();
      const result = await executeInfraTool(
        {
          id: "1",
          name: "deploy",
          input: { id: "some-app", name: "Some App", category: "utilities", icon: "&#128992;", iconBg: "#fff", description: "test" },
        },
        ctx,
      );

      expect(result).toContain("429");
      expect(ctx.onAppDeployed).not.toHaveBeenCalled();
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("claims ownership in D1 before any code is pushed", async () => {
    const originalFetch = globalThis.fetch;
    // 404 everywhere: the id is free. Repo creation then fails, but we only
    // care about who owns the id at the moment the deploy is announced.
    globalThis.fetch = vi.fn(() => Promise.resolve({ status: 404, json: () => Promise.resolve({}) })) as any;

    try {
      const apps = new Map<string, string>();
      const ctx = makeCtx({ ownerLogin: "SASASKIA", apps });
      let ownerAtDeployTime: string | undefined;
      ctx.onAppDeployed = vi.fn(() => {
        ownerAtDeployTime = apps.get("room-bloom");
      });

      await executeInfraTool(
        {
          id: "1",
          name: "deploy",
          input: { id: "room-bloom", name: "Room Bloom", category: "utilities", icon: "&#128992;", iconBg: "#fff", description: "t" },
        },
        ctx,
      );

      // The old code inserted the apps row only after a successful deploy, so
      // the builder's claim did not exist while their code was being pushed.
      expect(ownerAtDeployTime).toBe("SASASKIA");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("does not reuse an unclaimed id whose repo already exists, even when the session's appId matches", async () => {
    const originalFetch = globalThis.fetch;
    // "orphan-app" has a repo but no apps row — a legacy or abandoned deploy.
    // Session state must not be enough to push into it.
    globalThis.fetch = vi.fn((url: string) => {
      const orphan = typeof url === "string" && url.endsWith("/orphan-app");
      return Promise.resolve({ status: orphan ? 200 : 404, json: () => Promise.resolve(orphan ? { id: 123 } : {}) });
    }) as any;

    try {
      const apps = new Map<string, string>();
      const ctx = makeCtx({ appId: "orphan-app", ownerLogin: "SASASKIA", apps });
      await executeInfraTool(
        {
          id: "1",
          name: "deploy",
          input: { id: "orphan-app", name: "Orphan", category: "utilities", icon: "&#128992;", iconBg: "#fff", description: "t" },
        },
        ctx,
      );

      expect(ctx.onAppDeployed).not.toHaveBeenCalledWith("orphan-app", expect.anything());
      expect(apps.has("orphan-app")).toBe(false);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("releases a claim it just took when the deploy fails, leaving no phantom app", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn(() => Promise.resolve({ status: 404, json: () => Promise.resolve({}) })) as any;

    try {
      const apps = new Map<string, string>();
      const ctx = makeCtx({ ownerLogin: "SASASKIA", apps });
      const result = await executeInfraTool(
        {
          id: "1",
          name: "deploy",
          input: { id: "room-bloom", name: "Room Bloom", category: "utilities", icon: "&#128992;", iconBg: "#fff", description: "t" },
        },
        ctx,
      );

      expect(result).toContain("Deploy FAILED");
      expect(apps.has("room-bloom")).toBe(false);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

describe("executeInfraTool — build sanity preflight", () => {
  it("blocks deploy before repo checks when generated source has duplicate top-level declarations", async () => {
    const originalFetch = globalThis.fetch;
    const fetchSpy = vi.fn() as unknown as typeof fetch;
    globalThis.fetch = fetchSpy;

    try {
      const ctx = makeCtx();
      ctx.files.set("web/src/App.tsx", "function draw() {}\nfunction draw() {}\nexport default function App() { return null; }");
      const result = await executeInfraTool(
        {
          id: "1",
          name: "deploy",
          input: { id: "safe-app", name: "Safe App", category: "utilities", icon: "&#128992;", iconBg: "#fff", description: "test" },
        },
        ctx,
      );

      expect(result).toContain("Deploy BLOCKED");
      expect(result).toContain("duplicate top-level declaration");
      expect(ctx.onDeployStatus).toHaveBeenCalledWith({ phase: "error", error: "Build check failed: web/src/App.tsx" });
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("blocks push_update before pushing when generated source has multiple default exports", async () => {
    const originalFetch = globalThis.fetch;
    const fetchSpy = vi.fn() as unknown as typeof fetch;
    globalThis.fetch = fetchSpy;

    try {
      const ctx = makeCtx({ appId: "my-app" });
      ctx.files.set("web/src/App.tsx", "export default function A() { return null; }\nexport default function B() { return null; }");
      const result = await executeInfraTool({ id: "1", name: "push_update", input: { id: "my-app", message: "update" } }, ctx);

      expect(result).toContain("Deploy BLOCKED");
      expect(result).toContain("export default");
      expect(ctx.onDeployStatus).toHaveBeenCalledWith({ phase: "error", error: "Build check failed: web/src/App.tsx" });
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
