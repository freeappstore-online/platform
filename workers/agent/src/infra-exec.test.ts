import { describe, expect, it, vi } from "vitest";
import { getConfig } from "./config";
import type { DeployStatus } from "./deploy";
import { applyPlaceholders, executeInfraTool } from "./infra-exec";

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

function makeCtx(
  overrides: Partial<{
    appId: string | null;
  }> = {},
) {
  return {
    appId: overrides.appId ?? null,
    files: new Map<string, string>(),
    env: {
      GITHUB_TOKEN: "test-token",
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

  it("waits for push_update deploy status and marks the app live", async () => {
    vi.useFakeTimers();
    const originalFetch = globalThis.fetch;
    const commitSha = "abc123456789";
    globalThis.fetch = vi.fn(async (url: string, init?: RequestInit) => {
      const method = init?.method || "GET";
      if (method === "GET" && url.endsWith("/git/ref/heads/main")) {
        return { ok: true, json: async () => ({ object: { sha: "parent-sha" } }) } as Response;
      }
      if (method === "POST" && url.endsWith("/git/blobs")) {
        return { ok: true, json: async () => ({ sha: "blob-sha" }) } as Response;
      }
      if (method === "GET" && url.endsWith("/git/commits/parent-sha")) {
        return { ok: true, json: async () => ({ tree: { sha: "base-tree-sha" } }) } as Response;
      }
      if (method === "POST" && url.endsWith("/git/trees")) {
        return { ok: true, json: async () => ({ sha: "tree-sha" }) } as Response;
      }
      if (method === "POST" && url.endsWith("/git/commits")) {
        return { ok: true, json: async () => ({ sha: commitSha }) } as Response;
      }
      if (method === "PATCH" && url.endsWith("/git/refs/heads/main")) {
        return { ok: true, json: async () => ({ ref: "refs/heads/main" }) } as Response;
      }
      if (method === "GET" && url.endsWith("/actions/runs?per_page=10")) {
        return {
          ok: true,
          json: async () => ({ workflow_runs: [{ id: 123, status: "completed", conclusion: "success", head_sha: commitSha }] }),
        } as Response;
      }
      return { ok: false, status: 404, json: async () => ({ message: `Unexpected request: ${method} ${url}` }) } as Response;
    }) as typeof fetch;

    try {
      const ctx = makeCtx({ appId: "my-app" });
      ctx.files.set("web/src/App.tsx", "export default () => <div/>");
      const resultPromise = executeInfraTool({ id: "1", name: "push_update", input: { id: "my-app", message: "update" } }, ctx);
      await vi.advanceTimersByTimeAsync(8000);
      const result = await resultPromise;

      expect(result).toContain("Pushed update");
      expect(ctx.onDeployStatus).toHaveBeenCalledWith({ phase: "pushing", progress: "Pushing update..." });
      expect(ctx.onDeployStatus).toHaveBeenCalledWith({ phase: "building", deployUrl: "https://my-app.freeappstore.online" });
      expect(ctx.onDeployStatus).toHaveBeenCalledWith({ phase: "live", appUrl: "https://my-app.freeappstore.online" });
    } finally {
      globalThis.fetch = originalFetch;
      vi.useRealTimers();
    }
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

  it("allows re-deploy of same session app (skips uniqueness check)", async () => {
    // Mock fetch — should NOT be called for uniqueness since ctx.appId is set
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
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
