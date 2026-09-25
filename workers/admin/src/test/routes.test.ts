// Focused tests per route module (#17). Each module is called directly with a
// RouteContext, so a failure points at one file rather than the whole worker.
// The router block at the end covers what index.ts still owns: auth, CORS and
// the not-found fallback.

import { afterEach, describe, expect, it, vi } from "vitest";
import type { AuthResult } from "../auth";
import type { Env } from "../helpers";
import worker from "../index";
import { agentSessionsRoutes } from "../routes/agent-sessions";
import { aiKeysProxyRoutes } from "../routes/ai-keys-proxy";
import { appsRoutes } from "../routes/apps";
import { contentProxyRoutes } from "../routes/content-proxy";
import { creatorsRoutes } from "../routes/creators";
import { deprovisionRoutes } from "../routes/deprovision";
import { dnsRoutes } from "../routes/dns";
import { pingRoutes } from "../routes/ping";
import { provisionRoutes } from "../routes/provision";
import { reportsRoutes } from "../routes/reports";
import { statsRoutes } from "../routes/stats";
import type { RouteHandler } from "../routes/types";

afterEach(() => vi.unstubAllGlobals());

// ── Fakes ──

function fakeKV(initial: Record<string, string> = {}) {
  const store = new Map(Object.entries(initial));
  return {
    store,
    get: async (k: string) => store.get(k) ?? null,
    put: async (k: string, v: string) => void store.set(k, v),
    list: async () => ({ keys: [...store.keys()].map((name) => ({ name })) }),
  };
}

/** D1 fake: `first()` answers COUNT queries with `count`; `all()` returns `rows`; `run()` records binds. */
function fakeDB(opts: { count?: number; rows?: unknown[]; runs?: unknown[][] } = {}) {
  return {
    prepare: (_sql: string) => {
      let binds: unknown[] = [];
      const stmt = {
        bind: (...a: unknown[]) => {
          binds = a;
          return stmt;
        },
        first: async () => ({ count: opts.count ?? 0 }),
        all: async () => ({ results: opts.rows ?? [] }),
        run: async () => {
          opts.runs?.push(binds);
          return { meta: { changes: 1 } };
        },
      };
      return stmt;
    },
  };
}

/** Service binding that records calls and answers with `body`. */
function fakeBackend(body: unknown = { ok: true }, status = 200) {
  const calls: Array<{ url: string; method: string; token: string | null; body?: string }> = [];
  return {
    calls,
    fetch: async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push({
        url: String(input),
        method: init?.method ?? "GET",
        token: new Headers(init?.headers).get("X-Internal-Token"),
        body: init?.body as string | undefined,
      });
      return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
    },
  };
}

function env(overrides: Record<string, unknown> = {}): Env {
  return {
    CF_ACCOUNT_ID: "acc",
    CF_API_TOKEN: "cf",
    GITHUB_TOKEN: "gh",
    CI_TOKEN: "ci-token",
    FAS_ZONE_ID: "zone-fas",
    FGS_ZONE_ID: "zone-fgs",
    DB: fakeDB(),
    CREATORS: fakeKV(),
    ...overrides,
  } as unknown as Env;
}

function call(
  handler: RouteHandler,
  path: string,
  init: RequestInit = {},
  e: Env = env(),
  auth: AuthResult | null = { ok: true, kind: "local" },
) {
  const request = new Request(`https://admin.freeappstore.online${path}`, init);
  return handler({ request, env: e, url: new URL(request.url), auth });
}

const post = (body: unknown): RequestInit => ({
  method: "POST",
  body: JSON.stringify(body),
  headers: { "Content-Type": "application/json" },
});

// ── Modules ──

describe("routes/ping", () => {
  it("answers /api/ping and ignores everything else", async () => {
    expect(await (await call(pingRoutes, "/api/ping"))!.json()).toEqual({ ok: true, worker: "freeappstore-admin" });
    expect(await call(pingRoutes, "/api/pingx")).toBeNull();
  });
});

describe("routes/provision", () => {
  it("only claims POST /api/provision", async () => {
    expect(await call(provisionRoutes, "/api/provision")).toBeNull();
    expect(await call(provisionRoutes, "/api/provisions", { method: "POST" })).toBeNull();
  });

  it("rate-limits human admins at 3 per hour", async () => {
    const kv = fakeKV({ "ratelimit:alice:provision": "3" });
    const admin: AuthResult = { ok: true, kind: "admin", user: { id: "u1", login: "alice" } };
    const res = await call(provisionRoutes, "/api/provision", post({ id: "x" }), env({ CREATORS: kv }), admin);
    expect(res!.status).toBe(429);
  });

  it("does not rate-limit service-binding callers", async () => {
    const kv = fakeKV({ "ratelimit:alice:provision": "99" });
    // Missing name/store → handlePublish's own validation (400), proving we got past the limiter.
    const res = await call(provisionRoutes, "/api/provision", post({ id: "x" }), env({ CREATORS: kv }), { ok: true, kind: "service" });
    expect(res!.status).toBe(400);
    expect(((await res!.json()) as { steps: Array<{ name: string }> }).steps[0]!.name).toBe("Validation");
  });

  it("counts an admin's provision toward the limit", async () => {
    const kv = fakeKV();
    const admin: AuthResult = { ok: true, kind: "admin", user: { id: "u1", login: "bob", githubLogin: "bob-gh" } };
    await call(provisionRoutes, "/api/provision", post({ id: "x" }), env({ CREATORS: kv }), admin);
    expect(kv.store.get("ratelimit:bob-gh:provision")).toBe("1");
  });
});

describe("routes/deprovision", () => {
  it("requires id and store on both endpoints", async () => {
    for (const path of ["/api/unpublish", "/api/deprovision"]) {
      const res = await call(deprovisionRoutes, path, post({ id: "x" }));
      expect(res!.status).toBe(400);
    }
  });

  it("ignores non-POST", async () => {
    expect(await call(deprovisionRoutes, "/api/deprovision")).toBeNull();
  });
});

describe("routes/ai-keys-proxy", () => {
  const cases: Array<[string, string, string]> = [
    ["GET", "/api/ai-keys/users", "/v1/internal/keys/users"],
    ["GET", "/api/ai-keys/providers", "/v1/internal/keys/providers"],
    ["POST", "/api/ai-keys/userkey", "/v1/internal/keys/userkey"],
    ["POST", "/api/ai-keys/userkey/delete", "/v1/internal/keys/userkey/delete"],
    ["GET", "/api/ai-grants/users", "/v1/internal/keys/users"],
    ["GET", "/api/ai-grants", "/v1/internal/keys/grants"],
    ["POST", "/api/ai-grants", "/v1/internal/keys/grants"],
    ["POST", "/api/ai-grants/delete", "/v1/internal/keys/grants/delete"],
  ];

  it.each(cases)("%s %s → %s with the internal token", async (method, path, backendPath) => {
    const backend = fakeBackend({ proxied: true });
    const init: RequestInit = method === "POST" ? { method, body: '{"a":1}' } : { method };
    const res = await call(aiKeysProxyRoutes, path, init, env({ BACKEND_FAS: backend, ADMIN_PROVISION_TOKEN: "tok" }));
    expect(res!.status).toBe(200);
    expect(res!.headers.get("Cache-Control")).toBe("no-store");
    expect(backend.calls).toEqual([
      { url: `https://backend${backendPath}`, method, token: "tok", body: method === "POST" ? '{"a":1}' : undefined },
    ]);
  });

  it("405s a wrong method without calling the backend", async () => {
    const backend = fakeBackend();
    for (const [method, path] of [
      ["POST", "/api/ai-keys/users"],
      ["GET", "/api/ai-keys/userkey"],
      ["DELETE", "/api/ai-grants"],
    ] as const) {
      const res = await call(aiKeysProxyRoutes, path, { method }, env({ BACKEND_FAS: backend, ADMIN_PROVISION_TOKEN: "tok" }));
      expect(res!.status).toBe(405);
    }
    expect(backend.calls).toHaveLength(0);
  });

  it("500s when the backend binding or token is missing, and falls back to INTERNAL_TOKEN", async () => {
    expect((await call(aiKeysProxyRoutes, "/api/ai-keys/users", {}, env({ ADMIN_PROVISION_TOKEN: "tok" })))!.status).toBe(500);
    const backend = fakeBackend();
    await call(aiKeysProxyRoutes, "/api/ai-keys/users", {}, env({ BACKEND_FAS: backend, INTERNAL_TOKEN: "legacy" }));
    expect(backend.calls[0]!.token).toBe("legacy");
  });

  it("ignores unrelated paths", async () => {
    expect(await call(aiKeysProxyRoutes, "/api/ai-keys")).toBeNull();
  });
});

describe("routes/content-proxy", () => {
  it("maps to /v1/internal/admin/* and forwards the query string", async () => {
    const backend = fakeBackend();
    const res = await call(
      contentProxyRoutes,
      "/api/content/kv?app=a&prefix=b",
      { method: "DELETE" },
      env({ BACKEND_FAS: backend, ADMIN_PROVISION_TOKEN: "tok" }),
    );
    expect(res!.status).toBe(200);
    expect(backend.calls[0]).toMatchObject({ url: "https://backend/v1/internal/admin/kv?app=a&prefix=b", method: "DELETE", token: "tok" });
  });

  it("405s DELETE on the read-only kv/value path", async () => {
    const backend = fakeBackend();
    const res = await call(
      contentProxyRoutes,
      "/api/content/kv/value",
      { method: "DELETE" },
      env({ BACKEND_FAS: backend, ADMIN_PROVISION_TOKEN: "tok" }),
    );
    expect(res!.status).toBe(405);
    expect(backend.calls).toHaveLength(0);
  });

  it("relays backend errors with their status", async () => {
    const backend = fakeBackend({ error: "nope" }, 404);
    const res = await call(contentProxyRoutes, "/api/content/counters", {}, env({ BACKEND_FAS: backend, ADMIN_PROVISION_TOKEN: "tok" }));
    expect(res!.status).toBe(404);
    expect(await res!.json()).toEqual({ error: "nope" });
  });
});

describe("routes/stats", () => {
  it("returns counts and survives registry failures", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) =>
        String(input).includes("freeappstore/main/registry.json")
          ? new Response(JSON.stringify({ apps: [{ id: "a" }, { id: "b" }] }))
          : new Response("down", { status: 503 }),
      ),
    );
    const res = await call(statsRoutes, "/api/stats", {}, env({ DB: fakeDB({ count: 7 }), CREATORS: fakeKV({ c1: "{}", c2: "{}" }) }));
    expect(await res!.json()).toMatchObject({
      apps: 2,
      games: -1,
      users: 7,
      creators: 2,
      routes: 7,
      agentSessions: 7,
      errors: { registryGames: { status: 503, upstream: "registry:games" } },
    });
  });
});

describe("routes/creators", () => {
  it("lists creators, skipping empty and malformed KV entries", async () => {
    const kv = fakeKV({
      good: JSON.stringify({ github: "alice", apps: ["x"], banned: false, maxApps: 5, secret: "drop-me" }),
      bad: "{not json",
      arr: "[1,2]",
    });
    const res = await call(creatorsRoutes, "/api/creators", {}, env({ CREATORS: kv }));
    expect(await res!.json()).toEqual([{ github: "alice", apps: ["x"], banned: false, maxApps: 5 }]);
  });

  it("pages users and normalises fields", async () => {
    const db = fakeDB({
      count: 120,
      rows: [{ id: "u1", github_login: "alice", display_name: null, email: null, avatar_url: "p", provider: null }],
    });
    const res = await call(creatorsRoutes, "/api/users?page=2", {}, env({ DB: db }));
    expect(await res!.json()).toEqual({
      users: [
        {
          id: "u1",
          github_login: "alice",
          display_name: null,
          email: "",
          avatar_url: "p",
          provider: "github",
          name: "alice",
          photo_url: "p",
        },
      ],
      total: 120,
      page: 2,
      pages: 3,
    });
  });
});

describe("routes/reports", () => {
  it("stores a CI report within size limits", async () => {
    const kv = fakeKV();
    const ok = await call(reportsRoutes, "/api/test-report", { method: "PUT", body: "x".repeat(200) }, env({ CREATORS: kv }));
    expect(ok!.status).toBe(200);
    expect(kv.store.get("report:test-report:latest")).toHaveLength(200);
    expect((await call(reportsRoutes, "/api/test-report", { method: "PUT", body: "short" }))!.status).toBe(400);
    expect((await call(reportsRoutes, "/api/test-report", { method: "PUT", body: "x".repeat(512_001) }))!.status).toBe(413);
  });

  it("serves the latest report as HTML, 404 when none", async () => {
    expect((await call(reportsRoutes, "/test-report"))!.status).toBe(404);
    const res = await call(reportsRoutes, "/test-report", {}, env({ CREATORS: fakeKV({ "report:test-report:latest": "<h1>ok</h1>" }) }));
    expect(res!.headers.get("Content-Type")).toContain("text/html");
    expect(await res!.text()).toBe("<h1>ok</h1>");
  });
});

describe("routes/dns", () => {
  it("creates the CNAME on the store's zone and upserts the host route", async () => {
    const cfCalls: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        cfCalls.push(String(input));
        return new Response(JSON.stringify({ success: true }));
      }),
    );
    const runs: unknown[][] = [];
    const res = await call(dnsRoutes, "/api/fix-dns", post({ id: "timer", store: "apps" }), env({ DB: fakeDB({ runs }) }));
    const out = (await res!.json()) as { ok: boolean; steps: Array<{ name: string; status: string }> };
    expect(out.ok).toBe(true);
    expect(cfCalls).toEqual(["https://api.cloudflare.com/client/v4/zones/zone-fas/dns_records"]);
    expect(runs[0]!.slice(0, 4)).toEqual(["timer", "freeappstore.online", "apps/timer", "apps"]);
  });

  it("reports a CNAME failure without throwing", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify({ success: false, errors: [{ message: "record exists" }] }))),
    );
    const res = await call(dnsRoutes, "/api/fix-dns", post({ id: "timer", store: "games" }));
    const out = (await res!.json()) as { ok: boolean; steps: Array<{ name: string; status: string; detail: string }> };
    expect(out.ok).toBe(false);
    expect(out.steps[0]).toMatchObject({ name: "CNAME", status: "fail", detail: "record exists" });
  });
});

describe("routes/apps", () => {
  it("does not claim unrelated /api/apps paths", async () => {
    expect(await call(appsRoutes, "/api/apps/x/unknown")).toBeNull();
    expect(await call(appsRoutes, "/api/apps")).toBeNull();
  });

  it("serves deploy-status from the Worker cache when present", async () => {
    const cached = new Response(JSON.stringify({ timer: { status: "completed" } }));
    vi.stubGlobal("caches", { default: { match: async () => cached, put: async () => {} } });
    const res = await call(appsRoutes, "/api/apps/deploy-status");
    expect(await res!.json()).toEqual({ timer: { status: "completed" } });
  });

  it("caches a fresh per-app deploy-status for 60s", async () => {
    const puts: Array<{ key: string; cc: string | null }> = [];
    vi.stubGlobal("caches", {
      default: {
        match: async () => undefined,
        put: async (k: Request, r: Response) => void puts.push({ key: k.url, cc: r.headers.get("Cache-Control") }),
      },
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify({ workflow_runs: [] }))),
    );
    const res = await call(appsRoutes, "/api/apps/timer/deploy-status");
    expect(await res!.json()).toMatchObject({ appId: "timer", neverDeployed: true });
    expect(puts).toEqual([{ key: "https://admin.internal/api/apps/timer/deploy-status", cc: "public, max-age=60" }]);
  });
});

describe("routes/agent-sessions", () => {
  it("404s an unknown session id", async () => {
    const db = { prepare: () => ({ bind: () => ({ first: async () => null }) }) };
    const res = await call(agentSessionsRoutes, "/api/agent/sessions/nope", {}, env({ DB: db }));
    expect(res!.status).toBe(404);
  });

  it("ignores nested paths under a session", async () => {
    expect(await call(agentSessionsRoutes, "/api/agent/sessions/a/b")).toBeNull();
  });
});

// ── Router (index.ts) ──

describe("router", () => {
  const req = (path: string, init: RequestInit = {}) => new Request(`https://admin.freeappstore.online${path}`, init);

  it("rejects /api/* without credentials before any route runs", async () => {
    const res = await worker.fetch(req("/api/ping"), env({ ADMIN_PROVISION_TOKEN: "tok", BACKEND_FAS: fakeBackend() }));
    expect(res.status).toBe(401);
  });

  it("accepts the service-binding internal token", async () => {
    const res = await worker.fetch(
      req("/api/ping", { headers: { "X-Internal-Token": "tok" } }),
      env({ ADMIN_PROVISION_TOKEN: "tok", BACKEND_FAS: fakeBackend() }),
    );
    expect(res.status).toBe(200);
  });

  it("verifies a browser session through BACKEND_FAS and requires the admin role", async () => {
    const nonAdmin = fakeBackend({ id: "u", login: "u", roles: ["user"] });
    const res = await worker.fetch(
      req("/api/ping", { headers: { Authorization: "Bearer s" } }),
      env({ ADMIN_PROVISION_TOKEN: "tok", BACKEND_FAS: nonAdmin }),
    );
    expect(res.status).toBe(403);
    expect(nonAdmin.calls[0]!.url).toBe("https://backend/v1/auth/me");
  });

  it("lets a CI test-report upload through with X-CI-Token alone", async () => {
    const res = await worker.fetch(
      req("/api/test-report", { method: "PUT", headers: { "X-CI-Token": "ci-token" }, body: "x".repeat(200) }),
      env({ ADMIN_PROVISION_TOKEN: "tok", BACKEND_FAS: fakeBackend() }),
    );
    expect(res.status).toBe(200);
  });

  it("answers OPTIONS with CORS for an allowed origin", async () => {
    const res = await worker.fetch(
      req("/api/ping", { method: "OPTIONS", headers: { Origin: "https://console.freeappstore.online" } }),
      env(),
    );
    expect(res.status).toBe(204);
    expect(res.headers.get("Access-Control-Allow-Origin")).toBe("https://console.freeappstore.online");
  });

  it("falls back to JSON 404 under /api and a bare 404 elsewhere", async () => {
    const e = env({ ALLOW_LOCAL_ADMIN_AUTH: "true" });
    const api = await worker.fetch(req("/api/nope"), e);
    expect(api.status).toBe(404);
    expect(await api.json()).toEqual({ error: "not found" });
    const other = await worker.fetch(req("/nope"), e);
    expect(other.status).toBe(404);
    expect(await other.text()).toBe("");
  });
});
