import { afterEach, describe, expect, it, vi } from "vitest";
import { getDeployStatus } from "./deploy-status.js";

afterEach(() => vi.unstubAllGlobals());

type Step = { status: number; body: unknown; headers?: Record<string, string> };

/** Answers the repo lookup then the runs lookup; records the Authorization header of each call. */
function stub(steps: Step[]) {
  const seen: { url: string; auth: string | null }[] = [];
  vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
    const step = steps.shift()!;
    seen.push({ url, auth: new Headers(init?.headers).get("Authorization") });
    return new Response(JSON.stringify(step.body), { status: step.status, headers: step.headers });
  });
  return seen;
}

const publicRepo = { status: 200, body: { private: false } };
const run = { name: "Deploy", conclusion: "failure", status: "completed", updated_at: "2026-11-07T00:00:00Z", html_url: "https://github.com/o/a/actions/runs/1", head_sha: "abcdef123456" };

describe("getDeployStatus (#453)", () => {
  it("authenticates with the server token and returns the runs", async () => {
    const seen = stub([publicRepo, { status: 200, body: { workflow_runs: [run] } }]);
    expect(await getDeployStatus("o", "a", "srv-token")).toEqual({
      runs: [{ name: "Deploy", status: "failure", updatedAt: "2026-11-07T00:00:00Z", url: run.html_url, sha: "abcdef1" }],
    });
    expect(seen.map((s) => s.auth)).toEqual(["Bearer srv-token", "Bearer srv-token"]);
  });

  it("reports a rate limit with the retry time and the public Actions URL", async () => {
    stub([publicRepo, { status: 403, body: { message: "API rate limit exceeded for 1.2.3.4" }, headers: { "x-ratelimit-remaining": "0", "x-ratelimit-reset": String(Math.floor(Date.now() / 1000) + 120), "x-github-request-id": "REQ1" } }]);
    const result = (await getDeployStatus("o", "a", "t")) as { error: string };
    expect(result.error).toMatch(/rate limit reached; retry in about 1\d\ds/);
    expect(result.error).toContain("https://github.com/o/a/actions");
    expect(result.error).toContain("REQ1");
  });

  it("reports a 429 with retry-after", async () => {
    stub([publicRepo, { status: 429, body: {}, headers: { "retry-after": "30" } }]);
    expect(((await getDeployStatus("o", "a")) as { error: string }).error).toMatch(/retry in about 30s/);
  });

  it("tells a permission denial apart from a rate limit", async () => {
    stub([publicRepo, { status: 403, body: { message: "Resource not accessible by integration" }, headers: { "x-ratelimit-remaining": "4000" } }]);
    const { error } = (await getDeployStatus("o", "a", "t")) as { error: string };
    expect(error).toContain("permission denied: Resource not accessible by integration");
    expect(error).not.toMatch(/rate limit/);
  });

  it("explains a missing repo", async () => {
    stub([{ status: 404, body: { message: "Not Found" } }]);
    expect(((await getDeployStatus("o", "nope", "t")) as { error: string }).error).toMatch(/No repository or workflow runs found/);
  });

  it("reports an upstream failure", async () => {
    stub([publicRepo, { status: 502, body: { message: "Bad Gateway" } }]);
    expect(((await getDeployStatus("o", "a", "t")) as { error: string }).error).toMatch(/failing upstream \(HTTP 502\)/);
  });

  it("never exposes a private repository's runs, even with the server token", async () => {
    const seen = stub([{ status: 200, body: { private: true } }]);
    expect(((await getDeployStatus("o", "secret", "t")) as { error: string }).error).toMatch(/No repository or workflow runs found/);
    expect(seen).toHaveLength(1);
  });

  it("rejects a repo name that could escape the repos path without calling GitHub", async () => {
    const seen = stub([]);
    expect(await getDeployStatus("o", "../other/x", "t")).toEqual({ error: "invalid app_id: ../other/x" });
    expect(seen).toEqual([]);
  });

  it("works without a server token (anonymous)", async () => {
    const seen = stub([publicRepo, { status: 200, body: { workflow_runs: [] } }]);
    expect(await getDeployStatus("o", "a")).toEqual({ runs: [] });
    expect(seen.map((s) => s.auth)).toEqual([null, null]);
  });
});
