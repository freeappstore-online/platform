// CF Web Analytics provisioning at publish time (#8).
//
// The original bug: /api/provision built handlePublish's env by hand and left
// out BACKEND_FAS and ADMIN_PROVISION_TOKEN, so the minted RUM site_tag was
// never persisted to the FAS backend. These tests drive the real route with
// both bindings present and assert the backend callback actually happens, so
// dropping either binding from that env literal fails here, not in prod.

import { afterEach, describe, expect, it, vi } from "vitest";
import { handlePublish } from "../publish";

const ADMIN_TOKEN = "admin-provision-token";

/** Outbound fetch stub: GitHub succeeds; CF RUM list is empty and create
 *  returns a site_tag, unless `rumCreate` overrides the create response. */
function stubOutbound(rumCreate?: () => Response) {
  const calls: string[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input instanceof Request ? input.url : input);
      const method = init?.method ?? "GET";
      calls.push(`${method} ${url}`);
      const ok = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
      if (url.includes("/rum/site_info/list")) return ok({ success: true, result: [] });
      if (url.includes("/rum/site_info")) return rumCreate ? rumCreate() : ok({ success: true, result: { site_tag: "tag-123" } });
      if (url.includes("/collaborators/")) return new Response(null, { status: 204 });
      if (url.includes("registry.json") && method === "PUT") return ok({ content: { sha: "new" } });
      if (url.includes("registry.json")) return ok({ content: btoa(JSON.stringify({ apps: [] })), sha: "abc" });
      if (url.includes("api.github.com/repos/")) return ok({ id: 1 });
      throw new Error(`unexpected outbound fetch: ${method} ${url}`);
    }),
  );
  return calls;
}

function fakeDB() {
  const stmt = {
    bind: () => stmt,
    run: async () => ({ meta: { changes: 1 } }),
    // The existing repo is recorded as the publisher's own app (#9 ownership check).
    first: async () => ({ owner_login: "someone" }),
    all: async () => ({ results: [] }),
  };
  return { prepare: () => stmt, batch: async (s: unknown[]) => s.map(() => ({ meta: { changes: 1 } })) } as unknown as D1Database;
}

/** A BACKEND_FAS service binding that records every call. */
function fakeBackend(status = 200) {
  const calls: Array<{ url: string; method: string; token: string | null; body: string }> = [];
  const binding = {
    fetch: async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push({
        url: String(input instanceof Request ? input.url : input),
        method: init?.method ?? "GET",
        token: new Headers(init?.headers).get("X-Internal-Token"),
        body: String(init?.body ?? ""),
      });
      return new Response(status === 200 ? "{}" : "nope", { status });
    },
  };
  return { binding: binding as unknown as Fetcher, calls };
}

const provisionBody = {
  id: "testapp",
  name: "Test App",
  category: "utilities",
  icon: "x",
  iconBg: "#fff",
  description: "d",
  store: "apps",
  creatorGithub: "someone",
};

afterEach(() => vi.unstubAllGlobals());

describe("/api/provision → CF Web Analytics (#8)", () => {
  it("forwards BACKEND_FAS + ADMIN_PROVISION_TOKEN so the site_tag is persisted", async () => {
    stubOutbound();
    const backend = fakeBackend();
    const { default: worker } = await import("../index.js");
    const env = {
      CF_ACCOUNT_ID: "acc",
      CF_API_TOKEN: "cf",
      GITHUB_TOKEN: "gh",
      FAS_ZONE_ID: "zone1",
      FGS_ZONE_ID: "zone2",
      DB: fakeDB(),
      BACKEND_FAS: backend.binding,
      ADMIN_PROVISION_TOKEN: ADMIN_TOKEN,
    };

    const res = await worker.fetch(
      new Request("https://localhost/api/provision", {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Internal-Token": ADMIN_TOKEN },
        body: JSON.stringify(provisionBody),
      }),
      env as any,
    );
    const out = (await res.json()) as { steps: Array<{ name: string; status: string; detail?: string }> };

    const persist = backend.calls.find((c) => c.url.includes("/analytics/cf-token"));
    expect(persist).toEqual({
      url: "https://backend/v1/internal/apps/testapp/analytics/cf-token",
      method: "PUT",
      token: ADMIN_TOKEN,
      body: JSON.stringify({ cf_beacon_token: "tag-123" }),
    });
    const step = out.steps.find((s) => s.name === "CF Web Analytics");
    expect(step).toMatchObject({ status: "ok" });
    expect(step?.detail).toContain("persisted to FAS backend");
    expect(step?.detail).not.toContain("paste it manually");
  });

  it("falls back to legacy INTERNAL_TOKEN when ADMIN_PROVISION_TOKEN is unset", async () => {
    stubOutbound();
    const backend = fakeBackend();
    const { default: worker } = await import("../index.js");
    const env = {
      CF_ACCOUNT_ID: "acc",
      CF_API_TOKEN: "cf",
      GITHUB_TOKEN: "gh",
      FAS_ZONE_ID: "zone1",
      FGS_ZONE_ID: "zone2",
      DB: fakeDB(),
      BACKEND_FAS: backend.binding,
      INTERNAL_TOKEN: "legacy-token",
      ALLOW_LOCAL_ADMIN_AUTH: "true",
    };
    await worker.fetch(
      new Request("https://localhost/api/provision", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(provisionBody),
      }),
      env as any,
    );
    expect(backend.calls.find((c) => c.url.includes("/analytics/cf-token"))?.token).toBe("legacy-token");
  });
});

describe("handlePublish → CF Web Analytics outcomes", () => {
  const baseEnv = {
    CF_ACCOUNT_ID: "acc",
    CF_API_TOKEN: "cf",
    GITHUB_TOKEN: "gh",
    FAS_ZONE_ID: "zone1",
    FGS_ZONE_ID: "zone2",
    DB: fakeDB(),
  };
  const analytics = (steps: Array<{ name: string; status: string; detail?: string }>) => steps.find((s) => s.name === "CF Web Analytics");

  it("without the bindings, mints but asks for a manual paste (the #8 symptom path)", async () => {
    stubOutbound();
    const r = await handlePublish(provisionBody as any, { ...baseEnv, BACKEND_FAS: undefined, ADMIN_PROVISION_TOKEN: undefined });
    expect(analytics(r.steps)?.detail).toContain("no FAS backend binding — paste it manually");
  });

  it("a CF token without RUM permission is a non-fatal skip, publish still succeeds", async () => {
    stubOutbound(
      () => new Response(JSON.stringify({ success: false, errors: [{ code: 10000, message: "Authentication error" }] }), { status: 403 }),
    );
    const backend = fakeBackend();
    const r = await handlePublish(provisionBody as any, { ...baseEnv, BACKEND_FAS: backend.binding, ADMIN_PROVISION_TOKEN: ADMIN_TOKEN });
    expect(r.success).toBe(true);
    expect(analytics(r.steps)).toMatchObject({ status: "skip", detail: "(non-fatal) Authentication error" });
    expect(backend.calls).toHaveLength(0);
  });

  it("reports a backend persist failure instead of claiming success", async () => {
    stubOutbound();
    const backend = fakeBackend(500);
    const r = await handlePublish(provisionBody as any, { ...baseEnv, BACKEND_FAS: backend.binding, ADMIN_PROVISION_TOKEN: ADMIN_TOKEN });
    expect(analytics(r.steps)).toMatchObject({ status: "skip" });
    expect(analytics(r.steps)?.detail).toMatch(/minted site_tag=tag-123 but FAS backend persist failed \(500\)/);
  });
});
