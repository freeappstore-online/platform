// Registry and GitHub-runs readers must surface upstream failures instead of
// reporting them as "no registry entries" / "never deployed" (#72).

import { afterEach, describe, expect, it, vi } from "vitest";
import { type Env, fetchGhRuns, fetchRegistry, handleAppDeployStatus, handleAppHealth, handleAppsAll, handleDeployStatus } from "../helpers";

function stubFetch(handler: (url: string) => Response | Promise<Response>) {
  const f = vi.fn(async (input: RequestInfo | URL) => handler(String(input)));
  vi.stubGlobal("fetch", f);
  return f;
}

const ok = (body: unknown) => new Response(JSON.stringify(body), { status: 200 });
const status = (code: number) => new Response("upstream says no", { status: code });

/** D1 stub: `all()` returns the given rows, `first()` returns null. */
function fakeEnv(rows: Record<string, unknown>[] = []): Env {
  const stmt = { bind: () => stmt, all: async () => ({ results: rows }), first: async () => null };
  return { GITHUB_TOKEN: "t", DB: { prepare: () => stmt } } as unknown as Env;
}

afterEach(() => vi.unstubAllGlobals());

describe("fetchRegistry", () => {
  it("returns entries on 200", async () => {
    stubFetch(() => ok({ apps: [{ id: "a", name: "A" }] }));
    expect((await fetchRegistry("apps")).map((a) => a.id)).toEqual(["a"]);
  });

  it("returns [] only for a registry that genuinely lists nothing", async () => {
    stubFetch(() => ok({ apps: [] }));
    expect(await fetchRegistry("apps")).toEqual([]);
  });

  it.each([404, 429, 500, 503])("throws on HTTP %i", async (code) => {
    stubFetch(() => status(code));
    await expect(fetchRegistry("games")).rejects.toThrow(`HTTP ${code}`);
  });

  it("throws on network failure", async () => {
    stubFetch(() => Promise.reject(new TypeError("fetch failed")));
    await expect(fetchRegistry("apps")).rejects.toThrow("fetch failed");
  });

  it("throws on a body without the store's array", async () => {
    stubFetch(() => ok({ games: [] }));
    await expect(fetchRegistry("apps")).rejects.toThrow("malformed");
  });
});

describe("handleAppsAll", () => {
  it("fails instead of marking every app unlisted when the registry is down", async () => {
    stubFetch(() => status(503));
    await expect(handleAppsAll(fakeEnv())).rejects.toThrow("HTTP 503");
  });
});

describe("fetchGhRuns", () => {
  it("returns [] only when GitHub answers with no runs", async () => {
    stubFetch(() => ok({ total_count: 0, workflow_runs: [] }));
    expect(await fetchGhRuns("a", fakeEnv())).toEqual([]);
  });

  it.each([401, 403, 404, 500, 502])("throws on HTTP %i", async (code) => {
    stubFetch(() => status(code));
    await expect(fetchGhRuns("a", fakeEnv())).rejects.toThrow(`HTTP ${code}`);
  });

  it("throws on network failure / timeout", async () => {
    stubFetch(() => Promise.reject(new DOMException("timed out", "TimeoutError")));
    await expect(fetchGhRuns("a", fakeEnv())).rejects.toThrow("timed out");
  });
});

describe("deploy status", () => {
  it("single app: a GitHub error propagates rather than reading as neverDeployed", async () => {
    stubFetch(() => status(500));
    await expect(handleAppDeployStatus("a", fakeEnv())).rejects.toThrow("HTTP 500");
  });

  it("single app: no runs is neverDeployed", async () => {
    stubFetch(() => ok({ workflow_runs: [] }));
    expect(await handleAppDeployStatus("a", fakeEnv())).toMatchObject({ neverDeployed: true, runs: [] });
  });

  it("fan-out: a failing repo carries error, others are unaffected", async () => {
    stubFetch((url) =>
      url.includes("/repos/freeappstore-online/bad/")
        ? status(403)
        : ok({ workflow_runs: [{ id: 1, name: "deploy", status: "completed", conclusion: "success", created_at: "t", head_sha: "abcdef123" }] }),
    );
    const result = await handleDeployStatus(fakeEnv([{ id: "good" }, { id: "bad" }]));
    expect(result.good).toMatchObject({ conclusion: "success", neverDeployed: false });
    expect(result.good!.error).toBeUndefined();
    expect(result.bad).toMatchObject({ error: expect.stringContaining("HTTP 403"), conclusion: null });
    expect(result.bad!.neverDeployed).toBeUndefined();
  });
});

describe("handleAppHealth", () => {
  it("reports a GitHub failure as ghActionsError, not an empty run list", async () => {
    stubFetch((url) => (url.startsWith("https://api.github.com") ? status(503) : new Response(null, { status: 200 })));
    const h = await handleAppHealth("a", fakeEnv());
    expect(h.ghActions).toBeNull();
    expect(h.ghActionsError).toContain("HTTP 503");
    expect(h.reachable).toBe(true);
  });
});
