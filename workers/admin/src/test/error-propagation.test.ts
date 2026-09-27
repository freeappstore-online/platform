import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchGhRuns, fetchRegistry, handleAppHealth, UpstreamFetchError, type Env } from "../helpers";

const env = { GITHUB_TOKEN: "gh-test" } as Env;

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("fetchRegistry error propagation", () => {
  it("returns [] for a genuine 404 absence", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("missing", { status: 404 })),
    );

    await expect(fetchRegistry("apps")).resolves.toEqual([]);
  });

  it("throws on 500 instead of returning []", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("upstream down", { status: 500 })),
    );

    await expect(fetchRegistry("apps")).rejects.toMatchObject({
      name: "UpstreamFetchError",
      status: 500,
      upstream: "registry:apps",
    });
  });

  it("throws on 401 instead of returning []", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify({ message: "Bad credentials" }), { status: 401 })),
    );

    await expect(fetchRegistry("games")).rejects.toBeInstanceOf(UpstreamFetchError);
  });

  it("throws on network errors instead of returning []", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("network unavailable");
      }),
    );

    await expect(fetchRegistry("apps")).rejects.toMatchObject({
      status: 503,
      upstream: "registry:apps",
    });
  });
});

describe("fetchGhRuns error propagation", () => {
  it("returns [] for a 404 repo/no-runs absence", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("missing", { status: 404 })),
    );

    await expect(fetchGhRuns("calendar", env)).resolves.toEqual([]);
  });

  it("throws on 5xx instead of returning []", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify({ message: "GitHub unavailable" }), { status: 503 })),
    );

    await expect(fetchGhRuns("calendar", env)).rejects.toMatchObject({
      name: "UpstreamFetchError",
      status: 503,
      upstream: "github:actions",
    });
  });

  it("throws on network errors instead of returning []", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("socket reset");
      }),
    );

    await expect(fetchGhRuns("calendar", env)).rejects.toMatchObject({
      status: 503,
      upstream: "github:actions",
    });
  });
});

describe("app health when GitHub can't be read (#72)", () => {
  it("reports the GitHub error alongside the rest of the check, not as no runs or a failed page", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) =>
        String(input).includes("api.github.com") ? new Response("down", { status: 503 }) : new Response(null, { status: 200 }),
      ),
    );
    const db = {
      prepare: () => ({ bind: () => ({ first: async () => ({ slug: "calendar", zone: "freeappstore.online", hosted_on: "r2" }) }) }),
    };

    const health = await handleAppHealth("calendar", { ...env, DB: db } as unknown as Env);

    expect(health).toMatchObject({ id: "calendar", reachable: true, ghActions: null });
    expect(health.ghActionsError).toContain("503");
  });

  it("has no error when GitHub answers", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) =>
        String(input).includes("api.github.com")
          ? new Response(JSON.stringify({ workflow_runs: [] }))
          : new Response(null, { status: 200 }),
      ),
    );
    const db = { prepare: () => ({ bind: () => ({ first: async () => null }) }) };

    const health = await handleAppHealth("calendar", { ...env, DB: db } as unknown as Env);

    expect(health).toMatchObject({ ghActions: [], ghActionsError: null });
  });
});
