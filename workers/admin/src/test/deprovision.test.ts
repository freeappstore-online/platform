import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Test the actual deprovision handler by importing the worker and calling
// its fetch() with a mock env + mock external APIs.

function mockEnv() {
  return {
    CF_ACCOUNT_ID: "test-account",
    CF_API_TOKEN: "test-token",
    GITHUB_TOKEN: "ghp_test",
    CI_TOKEN: "ci-test",
    CF_ACCESS_TEAM_DOMAIN: "",
    CF_ACCESS_AUD: "",
    FAS_ZONE_ID: "fas-zone-123",
    FGS_ZONE_ID: "fgs-zone-456",
    ASSETS: { fetch: () => new Response("asset") },
    DB: {
      prepare: (sql: string) => ({
        bind: (..._args: unknown[]) => ({
          run: vi.fn().mockResolvedValue({ success: true }),
          all: vi.fn().mockResolvedValue({ results: [] }),
          first: vi.fn().mockResolvedValue(null),
        }),
        all: vi.fn().mockResolvedValue({ results: [] }),
        first: vi.fn().mockResolvedValue(null),
      }),
    },
    CREATORS: {
      list: async () => ({ keys: [] }),
      get: async () => null,
      put: async () => {},
    },
  };
}

describe("deprovision endpoint", () => {
  const originalFetch = globalThis.fetch;
  let fetchCalls: { url: string; method: string }[];

  beforeEach(() => {
    fetchCalls = [];
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      const method = init?.method || "GET";
      fetchCalls.push({ url, method });

      // Mock unpublish (self-call)
      if (url.includes("/api/unpublish") && method === "POST") {
        return new Response(JSON.stringify({ ok: true, id: "my-app" }), { status: 200 });
      }
      // Mock DNS list
      if (url.includes("/dns_records") && method === "GET") {
        return new Response(JSON.stringify({ success: true, result: [{ id: "dns-rec-1" }] }));
      }
      // Mock DNS delete
      if (url.includes("/dns_records/") && method === "DELETE") {
        return new Response(JSON.stringify({ success: true }));
      }
      // Mock repo delete
      if (url.includes("api.github.com/repos/") && method === "DELETE") {
        return new Response(null, { status: 204 });
      }
      return new Response(JSON.stringify({ success: true }));
    }) as any;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  async function callDeprovision(body: any, env?: any) {
    const { default: worker } = await import("../index.js");
    const request = new Request("https://localhost/api/deprovision", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    return worker.fetch(request, (env ?? mockEnv()) as any);
  }

  it("returns 400 when id is missing", async () => {
    const res = await callDeprovision({ store: "apps" });
    expect(res.status).toBe(400);
  });

  it("returns 400 when store is missing", async () => {
    const res = await callDeprovision({ id: "my-app" });
    expect(res.status).toBe(400);
  });

  it("runs registry + route + dns steps for apps", async () => {
    const res = await callDeprovision({ id: "my-app", store: "apps" });
    expect(res.status).toBe(200);
    const data = (await res.json()) as any;
    expect(data.ok).toBe(true);
    expect(data.id).toBe("my-app");

    const stepNames = data.steps.map((s: any) => s.name);
    expect(stepNames).toContain("registry");
    expect(stepNames).toContain("hosting_route");
    expect(stepNames).toContain("dns");
    // No CF Pages step
    expect(stepNames).not.toContain("cf_pages");
  });

  it("does NOT call CF Pages API", async () => {
    await callDeprovision({ id: "my-app", store: "apps" });
    const pagesCall = fetchCalls.find((c) => c.url.includes("/pages/projects"));
    expect(pagesCall).toBeUndefined();
  });

  it("deletes D1 route with correct domain for apps", async () => {
    const env = mockEnv();
    const bindSpy = vi.fn().mockReturnValue({ run: vi.fn().mockResolvedValue({ success: true }) });
    const prepareSpy = vi.fn().mockReturnValue({ bind: bindSpy });
    env.DB.prepare = prepareSpy as any;

    await callDeprovision({ id: "my-app", store: "apps" }, env);

    // Find the DELETE FROM routes call
    const deleteCall = prepareSpy.mock.calls.find((c: any[]) => typeof c[0] === "string" && c[0].includes("DELETE FROM routes"));
    expect(deleteCall).toBeDefined();
    expect(bindSpy).toHaveBeenCalledWith("my-app", "freeappstore.online");
  });

  it("deletes D1 route with correct domain for games", async () => {
    const env = mockEnv();
    const bindSpy = vi.fn().mockReturnValue({ run: vi.fn().mockResolvedValue({ success: true }) });
    const prepareSpy = vi.fn().mockReturnValue({ bind: bindSpy });
    env.DB.prepare = prepareSpy as any;

    await callDeprovision({ id: "chess", store: "games" }, env);

    const deleteCall = prepareSpy.mock.calls.find((c: any[]) => typeof c[0] === "string" && c[0].includes("DELETE FROM routes"));
    expect(deleteCall).toBeDefined();
    expect(bindSpy).toHaveBeenCalledWith("chess", "freegamestore.online");
  });

  it("deletes DNS records using correct zone for apps", async () => {
    await callDeprovision({ id: "my-app", store: "apps" });
    const dnsListCall = fetchCalls.find((c) => c.url.includes("/dns_records") && c.url.includes("fas-zone-123") && c.method === "GET");
    expect(dnsListCall).toBeDefined();
    expect(dnsListCall!.url).toContain("my-app.freeappstore.online");
  });

  it("deletes DNS records using correct zone for games", async () => {
    await callDeprovision({ id: "chess", store: "games" });
    const dnsListCall = fetchCalls.find((c) => c.url.includes("/dns_records") && c.url.includes("fgs-zone-456") && c.method === "GET");
    expect(dnsListCall).toBeDefined();
    expect(dnsListCall!.url).toContain("chess.freegamestore.online");
  });

  it("deletes repo when deleteRepo=true", async () => {
    const res = await callDeprovision({ id: "my-app", store: "apps", deleteRepo: true });
    const data = (await res.json()) as any;
    const stepNames = data.steps.map((s: any) => s.name);
    expect(stepNames).toContain("delete_repo");

    const repoCall = fetchCalls.find((c) => c.url.includes("api.github.com/repos/freeappstore-online/my-app") && c.method === "DELETE");
    expect(repoCall).toBeDefined();
  });

  it("does NOT delete repo when deleteRepo is not set", async () => {
    const res = await callDeprovision({ id: "my-app", store: "apps" });
    const data = (await res.json()) as any;
    const stepNames = data.steps.map((s: any) => s.name);
    expect(stepNames).not.toContain("delete_repo");
  });
});

describe("fix-dns endpoint", () => {
  const originalFetch = globalThis.fetch;
  let fetchCalls: { url: string; method: string; body?: any }[];

  beforeEach(() => {
    fetchCalls = [];
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      const method = init?.method || "GET";
      let body: any;
      if (init?.body) {
        try {
          body = JSON.parse(init.body as string);
        } catch {
          body = init.body;
        }
      }
      fetchCalls.push({ url, method, body });

      if (url.includes("/dns_records") && method === "POST") {
        return new Response(JSON.stringify({ success: true }));
      }
      return new Response(JSON.stringify({ success: true }));
    }) as any;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  async function callFixDns(body: any) {
    const { default: worker } = await import("../index.js");
    const request = new Request("https://localhost/api/fix-dns", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    return worker.fetch(request, mockEnv() as any);
  }

  it("returns 400 when id or store is missing", async () => {
    const res = await callFixDns({ id: "my-app" });
    expect(res.status).toBe(400);
  });

  it("creates CNAME pointing at host worker domain, NOT pages.dev", async () => {
    const res = await callFixDns({ id: "my-app", store: "apps" });
    expect(res.status).toBe(200);
    const data = (await res.json()) as any;
    expect(data.ok).toBe(true);

    const cnameCall = fetchCalls.find((c) => c.url.includes("/dns_records") && c.method === "POST");
    expect(cnameCall).toBeDefined();
    // CNAME content must be the zone apex (host worker), NOT *.pages.dev
    expect(cnameCall!.body.content).toBe("freeappstore.online");
    expect(cnameCall!.body.content).not.toContain("pages.dev");
    expect(cnameCall!.body.name).toBe("my-app.freeappstore.online");
    expect(cnameCall!.body.proxied).toBe(true);
  });

  it("uses correct zone + domain for games", async () => {
    await callFixDns({ id: "chess", store: "games" });

    const cnameCall = fetchCalls.find((c) => c.url.includes("/dns_records") && c.method === "POST");
    expect(cnameCall).toBeDefined();
    expect(cnameCall!.url).toContain("fgs-zone-456");
    expect(cnameCall!.body.content).toBe("freegamestore.online");
    expect(cnameCall!.body.name).toBe("chess.freegamestore.online");
  });

  it("does NOT call CF Pages custom domain API", async () => {
    await callFixDns({ id: "my-app", store: "apps" });
    const pagesCall = fetchCalls.find((c) => c.url.includes("/pages/projects"));
    expect(pagesCall).toBeUndefined();
  });
});
