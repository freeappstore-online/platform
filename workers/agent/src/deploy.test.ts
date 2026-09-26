import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getConfig } from "./config";
import {
  computeFileDelta,
  DEPLOY_POLL_TIMEOUT_MS,
  type DeployStatus,
  deployApp,
  keyErrorLines,
  pushUpdate,
  readDeployRun,
  waitForGitHubDeploy,
} from "./deploy";
// Most deploy flow tests exercise executeInfraTool, which wraps the GitHub
// helpers; the baseline/delta tests below mock fetch at the Git API boundary.
import { executeInfraTool } from "./infra-exec";

const appsConfig = getConfig("apps");
const gamesConfig = getConfig("games");

const mockEnv = {
  GITHUB_TOKEN: "ghp_test",
};

let originalFetch: typeof fetch;

beforeEach(() => {
  originalFetch = globalThis.fetch;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe("deploy uniqueness — apps", () => {
  it("auto-resolves to the next free ID when the requested one is taken (HTTP 200)", async () => {
    // Base "taken-app" exists (200); the "-2" variant and other URLs are free (404).
    globalThis.fetch = vi.fn((url: string) => {
      const taken = typeof url === "string" && url.endsWith("/taken-app");
      return Promise.resolve({ status: taken ? 200 : 404, json: () => Promise.resolve(taken ? { id: 1 } : {}) });
    }) as any;
    const onAppDeployed = vi.fn();

    const result = await executeInfraTool(
      {
        id: "1",
        name: "deploy",
        input: { id: "taken-app", name: "Taken", category: "utilities", icon: "x", iconBg: "#fff", description: "test" },
      },
      { appId: null, files: new Map(), env: mockEnv, config: appsConfig, onDeployStatus: vi.fn(), onAppDeployed },
    );
    expect(result).not.toContain("already taken");
    expect(onAppDeployed).toHaveBeenCalledWith("taken-app-2", "Taken");
  });

  it("allows deploy when repo does not exist (HTTP 404)", async () => {
    // First call: uniqueness check (404 = not taken)
    // Subsequent calls: deploy flow (will fail but that's fine — we just check it gets past uniqueness)
    const mockFetch = vi
      .fn()
      .mockResolvedValueOnce({ status: 404, json: () => Promise.resolve({ message: "Not Found" }) }) // uniqueness check
      .mockResolvedValue({ status: 200, json: () => Promise.resolve({ id: null, message: "error" }) }); // deploy calls fail
    globalThis.fetch = mockFetch as any;

    const result = await executeInfraTool(
      {
        id: "1",
        name: "deploy",
        input: { id: "new-app", name: "New", category: "utilities", icon: "x", iconBg: "#fff", description: "test" },
      },
      { appId: null, files: new Map(), env: mockEnv, config: appsConfig, onDeployStatus: vi.fn(), onAppDeployed: vi.fn() },
    );
    // Should NOT contain "already taken" — it passed uniqueness check
    expect(result).not.toContain("already taken");
  });

  it("skips uniqueness check for re-deploy (appId matches)", async () => {
    // Mock: repo exists (200) — but since ctx.appId is set, uniqueness check is skipped
    // The deploy flow will still call the repo endpoint, but should NOT return "already taken"
    const mockFetch = vi.fn().mockResolvedValue({ status: 200, json: () => Promise.resolve({ id: 123 }) }) as any;
    globalThis.fetch = mockFetch as any;

    const result = await executeInfraTool(
      {
        id: "1",
        name: "deploy",
        input: { id: "my-app", name: "My App", category: "utilities", icon: "x", iconBg: "#fff", description: "test" },
      },
      { appId: "my-app", files: new Map(), env: mockEnv, config: appsConfig, onDeployStatus: vi.fn(), onAppDeployed: vi.fn() },
    );
    // Should NOT contain "already taken" — uniqueness check was skipped
    expect(result).not.toContain("already taken");
  });
});

describe("deploy uniqueness — games", () => {
  it("auto-resolves to the next free ID when the requested one is taken", async () => {
    // Base "taken-game" exists (200); the "-2" variant and other URLs are free (404).
    globalThis.fetch = vi.fn((url: string) => {
      const taken = typeof url === "string" && url.endsWith("/taken-game");
      return Promise.resolve({ status: taken ? 200 : 404, json: () => Promise.resolve(taken ? { id: 1 } : {}) });
    }) as any;
    const onAppDeployed = vi.fn();

    const result = await executeInfraTool(
      {
        id: "1",
        name: "deploy",
        input: { id: "taken-game", name: "Taken", category: "arcade", icon: "x", iconBg: "#fff", description: "test" },
      },
      { appId: null, files: new Map(), env: mockEnv, config: gamesConfig, onDeployStatus: vi.fn(), onAppDeployed },
    );
    expect(result).not.toContain("already taken");
    expect(onAppDeployed).toHaveBeenCalledWith("taken-game-2", "Taken");
    // Verify it checked the correct org
    expect((globalThis.fetch as any).mock.calls[0][0]).toContain("freegamestore-online");
  });
});

describe("deploy ID validation edge cases", () => {
  it("rejects ID with spaces", async () => {
    const result = await executeInfraTool(
      {
        id: "1",
        name: "deploy",
        input: { id: "my app", name: "My App", category: "utilities", icon: "x", iconBg: "#fff", description: "test" },
      },
      { appId: null, files: new Map(), env: mockEnv, config: appsConfig, onDeployStatus: vi.fn(), onAppDeployed: vi.fn() },
    );
    expect(result).toContain("invalid");
  });

  it("rejects ID with uppercase", async () => {
    const result = await executeInfraTool(
      {
        id: "1",
        name: "deploy",
        input: { id: "MyApp", name: "My App", category: "utilities", icon: "x", iconBg: "#fff", description: "test" },
      },
      { appId: null, files: new Map(), env: mockEnv, config: appsConfig, onDeployStatus: vi.fn(), onAppDeployed: vi.fn() },
    );
    expect(result).toContain("invalid");
  });

  it("rejects ID starting with hyphen", async () => {
    const result = await executeInfraTool(
      {
        id: "1",
        name: "deploy",
        input: { id: "-my-app", name: "My App", category: "utilities", icon: "x", iconBg: "#fff", description: "test" },
      },
      { appId: null, files: new Map(), env: mockEnv, config: appsConfig, onDeployStatus: vi.fn(), onAppDeployed: vi.fn() },
    );
    expect(result).toContain("invalid");
  });

  it("rejects ID ending with hyphen", async () => {
    const result = await executeInfraTool(
      {
        id: "1",
        name: "deploy",
        input: { id: "my-app-", name: "My App", category: "utilities", icon: "x", iconBg: "#fff", description: "test" },
      },
      { appId: null, files: new Map(), env: mockEnv, config: appsConfig, onDeployStatus: vi.fn(), onAppDeployed: vi.fn() },
    );
    expect(result).toContain("invalid");
  });

  it("rejects ID over 58 chars", async () => {
    const result = await executeInfraTool(
      {
        id: "1",
        name: "deploy",
        input: { id: "a".repeat(59), name: "Long", category: "utilities", icon: "x", iconBg: "#fff", description: "test" },
      },
      { appId: null, files: new Map(), env: mockEnv, config: appsConfig, onDeployStatus: vi.fn(), onAppDeployed: vi.fn() },
    );
    expect(result).toContain("invalid");
  });

  it("allows valid ID with hyphens and numbers", async () => {
    globalThis.fetch = vi
      .fn()
      .mockResolvedValueOnce({ status: 404 })
      .mockResolvedValue({ status: 200, json: () => Promise.resolve({ id: null }) }) as any;

    const result = await executeInfraTool(
      {
        id: "1",
        name: "deploy",
        input: { id: "my-cool-app-2", name: "Cool", category: "utilities", icon: "x", iconBg: "#fff", description: "test" },
      },
      { appId: null, files: new Map(), env: mockEnv, config: appsConfig, onDeployStatus: vi.fn(), onAppDeployed: vi.fn() },
    );
    expect(result).not.toContain("invalid");
  });

  it("allows single character ID", async () => {
    globalThis.fetch = vi
      .fn()
      .mockResolvedValueOnce({ status: 404 })
      .mockResolvedValue({ status: 200, json: () => Promise.resolve({ id: null }) }) as any;

    const result = await executeInfraTool(
      { id: "1", name: "deploy", input: { id: "x", name: "X", category: "utilities", icon: "x", iconBg: "#fff", description: "test" } },
      { appId: null, files: new Map(), env: mockEnv, config: appsConfig, onDeployStatus: vi.fn(), onAppDeployed: vi.fn() },
    );
    expect(result).not.toContain("invalid");
  });
});

describe("infra tool authorization", () => {
  it("rejects get_build_logs for different app", async () => {
    const result = await executeInfraTool(
      { id: "1", name: "get_build_logs", input: { id: "other-app" } },
      { appId: "my-app", files: new Map(), env: mockEnv, config: appsConfig, onDeployStatus: vi.fn(), onAppDeployed: vi.fn() },
    );
    expect(result).toContain("you can only");
    expect(result).toContain("my-app");
  });

  it("rejects check_deploy_status for different app", async () => {
    const result = await executeInfraTool(
      { id: "1", name: "check_deploy_status", input: { id: "other-app" } },
      { appId: "my-app", files: new Map(), env: mockEnv, config: appsConfig, onDeployStatus: vi.fn(), onAppDeployed: vi.fn() },
    );
    expect(result).toContain("you can only");
  });

  it("rejects get_ci_results with no deployed app", async () => {
    const result = await executeInfraTool(
      { id: "1", name: "get_ci_results", input: { id: "some-app" } },
      { appId: null, files: new Map(), env: mockEnv, config: appsConfig, onDeployStatus: vi.fn(), onAppDeployed: vi.fn() },
    );
    expect(result).toContain("no app deployed yet");
  });

  it("uses game noun in error messages for games config", async () => {
    const result = await executeInfraTool(
      { id: "1", name: "push_update", input: { id: "some-game" } },
      { appId: null, files: new Map(), env: mockEnv, config: gamesConfig, onDeployStatus: vi.fn(), onAppDeployed: vi.fn() },
    );
    expect(result).toContain("no game deployed yet");
  });
});

describe("baseline/delta deploy protection", () => {
  function baseline() {
    return new Map<string, string>([
      ["web/src/App.tsx", "export default function App() { return <main>Template</main>; }"],
      ["web/src/main.tsx", "platform main"],
      ["web/package.json", '{"dependencies":{"@freeappstore/sdk":"^0.14.25"}}'],
      [".github/workflows/deploy.yml", "platform workflow"],
      ["pnpm-lock.yaml", "platform lockfile"],
    ]);
  }

  it("empty-delta: reports no files when generated files match the baseline", () => {
    const files = baseline();
    expect([...computeFileDelta(files, baseline()).entries()]).toEqual([]);
  });

  it("edit: includes only an edited app source file", () => {
    const files = baseline();
    files.set("web/src/App.tsx", "export default function App() { return <main>Agent edit</main>; }");
    expect([...computeFileDelta(files, baseline()).entries()]).toEqual([
      ["web/src/App.tsx", "export default function App() { return <main>Agent edit</main>; }"],
    ]);
  });

  it("new-file: includes new agent-authored files", () => {
    const files = baseline();
    files.set("web/src/components/Widget.tsx", "export function Widget() { return null; }");
    expect([...computeFileDelta(files, baseline()).entries()]).toEqual([
      ["web/src/components/Widget.tsx", "export function Widget() { return null; }"],
    ]);
  });

  it("package: includes an explicit package change without pulling in unchanged scaffold", () => {
    const files = baseline();
    files.set("web/package.json", '{"dependencies":{"@freeappstore/sdk":"^0.14.25","three":"^0.180.0"}}');
    const delta = computeFileDelta(files, baseline());
    expect([...delta.keys()]).toEqual(["web/package.json"]);
    expect(delta.get("web/package.json")).toContain("three");
  });

  it("workflow: preserves the platform workflow when it was not agent-authored", () => {
    const files = baseline();
    files.set("web/src/App.tsx", "changed");
    const delta = computeFileDelta(files, baseline());
    expect(delta.has(".github/workflows/deploy.yml")).toBe(false);
  });

  it("lockfile: preserves the platform lockfile when it was not agent-authored", () => {
    const files = baseline();
    files.set("web/src/App.tsx", "changed");
    const delta = computeFileDelta(files, baseline());
    expect(delta.has("pnpm-lock.yaml")).toBe(false);
  });

  it("base-tree: push_update merges only the delta onto the current repo tree", async () => {
    const originalFetch = globalThis.fetch;
    const treeBodies: any[] = [];
    globalThis.fetch = vi.fn(async (url: string, init?: RequestInit) => {
      const method = init?.method || "GET";
      if (method === "GET" && url.endsWith("/git/ref/heads/main")) {
        return { json: async () => ({ object: { sha: "parent-sha" } }) } as Response;
      }
      if (method === "POST" && url.endsWith("/git/blobs")) {
        return { json: async () => ({ sha: "blob-sha" }) } as Response;
      }
      if (method === "GET" && url.endsWith("/git/commits/parent-sha")) {
        return { json: async () => ({ tree: { sha: "base-tree-sha" } }) } as Response;
      }
      if (method === "POST" && url.endsWith("/git/trees")) {
        treeBodies.push(JSON.parse(String(init?.body)));
        return { json: async () => ({ sha: "tree-sha" }) } as Response;
      }
      if (method === "POST" && url.endsWith("/git/commits")) {
        return { json: async () => ({ sha: "commit-sha" }) } as Response;
      }
      if (method === "PATCH" && url.endsWith("/git/refs/heads/main")) {
        return { json: async () => ({ ref: "refs/heads/main" }) } as Response;
      }
      return { json: async () => ({ message: `Unexpected request: ${method} ${url}` }) } as Response;
    }) as typeof fetch;

    try {
      const files = baseline();
      files.set("web/src/App.tsx", "changed");
      const result = await pushUpdate("my-app", files, baseline(), "Update app", mockEnv, appsConfig);

      expect(result.ok).toBe(true);
      expect(treeBodies).toHaveLength(1);
      expect(treeBodies[0].base_tree).toBe("base-tree-sha");
      expect(treeBodies[0].tree).toEqual([{ path: "web/src/App.tsx", mode: "100644", type: "blob", sha: "blob-sha" }]);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("first deploy seeds the platform scaffold, then pushes only the agent delta via base_tree", async () => {
    vi.useFakeTimers();
    const originalFetch = globalThis.fetch;
    const treeBodies: any[] = [];
    const repoCreateBodies: any[] = [];
    let blobCount = 0;
    let commitCount = 0;
    const routes: {
      method: string;
      suffix: string;
      json: (init?: RequestInit) => unknown;
    }[] = [
      { method: "GET", suffix: "/repos/freeappstore-online/my-app", json: () => ({}) },
      {
        method: "POST",
        suffix: "/orgs/freeappstore-online/repos",
        json: (init) => {
          repoCreateBodies.push(JSON.parse(String(init?.body)));
          return { id: 123 };
        },
      },
      {
        method: "GET",
        suffix: "/git/ref/heads/main",
        json: () => (commitCount > 0 ? { object: { sha: "scaffold-sha" } } : {}),
      },
      {
        method: "POST",
        suffix: "/git/blobs",
        json: () => {
          blobCount += 1;
          return { sha: `blob-${blobCount}` };
        },
      },
      {
        method: "POST",
        suffix: "/git/trees",
        json: (init) => {
          treeBodies.push(JSON.parse(String(init?.body)));
          return { sha: treeBodies.length === 1 ? "scaffold-tree" : "delta-tree" };
        },
      },
      {
        method: "POST",
        suffix: "/git/commits",
        json: () => {
          commitCount += 1;
          return { sha: commitCount === 1 ? "scaffold-sha" : "delta-sha" };
        },
      },
      { method: "POST", suffix: "/git/refs", json: () => ({ ref: "refs/heads/main" }) },
      { method: "GET", suffix: "/git/commits/scaffold-sha", json: () => ({ tree: { sha: "scaffold-tree" } }) },
      { method: "PATCH", suffix: "/git/refs/heads/main", json: () => ({ ref: "refs/heads/main" }) },
      {
        method: "GET",
        suffix: "/actions/runs?per_page=10",
        json: () => ({ workflow_runs: [{ id: 1, status: "completed", conclusion: "success", head_sha: "delta-sha" }] }),
      },
    ];
    globalThis.fetch = vi.fn(async (url: string, init?: RequestInit) => {
      const method = init?.method || "GET";
      const route = routes.find((candidate) => candidate.method === method && url.endsWith(candidate.suffix));
      return { json: async () => (route ? route.json(init) : { message: `Unexpected request: ${method} ${url}` }) } as Response;
    }) as typeof fetch;

    try {
      const base = baseline();
      const files = baseline();
      files.set("web/src/App.tsx", "changed");
      const status = vi.fn();
      const result = deployApp(
        { id: "my-app", name: "My App", category: "utilities", icon: "x", iconBg: "#fff", description: "test" },
        files,
        mockEnv,
        appsConfig,
        status,
        false,
        base,
      );
      await vi.advanceTimersByTimeAsync(8000);
      await result;

      expect(repoCreateBodies[0]).toMatchObject({ name: "my-app", auto_init: false });
      expect(treeBodies).toHaveLength(2);
      expect(treeBodies[0].base_tree).toBeUndefined();
      expect(treeBodies[0].tree.map((entry: { path: string }) => entry.path).sort()).toEqual([...base.keys()].sort());
      expect(treeBodies[1].base_tree).toBe("scaffold-tree");
      expect(treeBodies[1].tree).toEqual([{ path: "web/src/App.tsx", mode: "100644", type: "blob", sha: "blob-6" }]);
      expect(status).toHaveBeenCalledWith({ phase: "live", appUrl: "https://my-app.freeappstore.online" });
    } finally {
      globalThis.fetch = originalFetch;
      vi.useRealTimers();
    }
  });

  it("status message: empty push_update is a successful no-op", async () => {
    const originalFetch = globalThis.fetch;
    const fetchSpy = vi.fn() as unknown as typeof fetch;
    globalThis.fetch = fetchSpy;
    try {
      const result = await pushUpdate("my-app", baseline(), baseline(), "Update app", mockEnv, appsConfig);
      expect(result).toEqual({
        ok: true,
        skipped: true,
        message: "No agent-authored changes to push for freeappstore-online/my-app; platform scaffold and current app files are unchanged.",
      });
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

describe("deploy run polling (#11)", () => {
  const SHA = "abc123";
  const FAILED_LOG = [
    "2026-09-26T10:00:01.0000000Z > vite build",
    "2026-09-26T10:00:02.0000000Z src/App.tsx(3,7): error TS2322: Type 'string' is not assignable to type 'number'.",
    "2026-09-26T10:00:02.5000000Z ##[error]Process completed with exit code 2.",
  ].join("\n");

  /** GitHub stand-in: the run for SHA has `run`'s state; jobs + logs for a failure. */
  function mockGitHub(run: { status: string; conclusion: string | null }) {
    globalThis.fetch = vi.fn(async (url: string) => {
      if (url.includes("/actions/runs?")) return Response.json({ workflow_runs: [{ id: 7, head_sha: SHA, ...run }] });
      if (url.endsWith("/actions/runs/7/jobs")) {
        return Response.json({
          jobs: [
            {
              id: 70,
              name: "build",
              status: "completed",
              conclusion: "failure",
              steps: [
                { name: "Install", status: "completed", conclusion: "success" },
                { name: "Build web", status: "completed", conclusion: "failure" },
                { name: "Upload to R2", status: "completed", conclusion: "skipped" },
              ],
            },
          ],
        });
      }
      if (url.endsWith("/actions/jobs/70/logs")) return new Response(FAILED_LOG);
      return new Response("{}", { status: 404 });
    }) as typeof fetch;
  }

  it("a failed run leads with the failing step and error line, within the 500 chars the session keeps", async () => {
    mockGitHub({ status: "completed", conclusion: "failure" });

    const status = await readDeployRun("dict", mockEnv, appsConfig, SHA);

    expect(status?.phase).toBe("error");
    const head = status?.phase === "error" ? status.error.slice(0, 500) : "";
    expect(head).toMatch(/^Build failed at build › Build web \(run 7\)/);
    expect(head).toContain("src/App.tsx(3,7): error TS2322");
    expect(head).toContain("https://github.com/freeappstore-online/dict/actions/runs/7");
  });

  it("a successful run is live", async () => {
    mockGitHub({ status: "completed", conclusion: "success" });
    expect(await readDeployRun("dict", mockEnv, appsConfig, SHA)).toEqual({ phase: "live", appUrl: "https://dict.freeappstore.online" });
  });

  it("an unfinished run is not a result yet", async () => {
    mockGitHub({ status: "in_progress", conclusion: null });
    expect(await readDeployRun("dict", mockEnv, appsConfig, SHA)).toBeNull();
  });

  it("times out as still building: returns null and never reports live", async () => {
    vi.useFakeTimers();
    try {
      mockGitHub({ status: "in_progress", conclusion: null });
      const statuses: DeployStatus[] = [];
      const done = waitForGitHubDeploy("dict", mockEnv, appsConfig, (s) => void statuses.push(s), SHA);
      await vi.advanceTimersByTimeAsync(DEPLOY_POLL_TIMEOUT_MS + 10_000);

      expect(await done).toBeNull();
      expect(statuses).toEqual([{ phase: "building", deployUrl: "https://dict.freeappstore.online" }]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("keyErrorLines keeps error lines, drops timestamps and the exit-code noise", () => {
    expect(keyErrorLines(FAILED_LOG)).toEqual(["src/App.tsx(3,7): error TS2322: Type 'string' is not assignable to type 'number'."]);
  });
});
