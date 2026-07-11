import { describe, expect, it, vi } from "vitest";

// Minimal mock of the admin worker to test the new endpoints.
// We import the worker and call fetch() directly with a mock env.

function mockEnv(overrides?: Partial<Record<string, unknown>>) {
  return {
    CF_ACCOUNT_ID: "test-account",
    CF_API_TOKEN: "test-token",
    GITHUB_TOKEN: "ghp_test",
    CI_TOKEN: "ci-test",
    CF_ACCESS_TEAM_DOMAIN: "",
    CF_ACCESS_AUD: "",
    FAS_ZONE_ID: "zone1",
    FGS_ZONE_ID: "zone2",
    ASSETS: { fetch: () => new Response("asset") },
    DB: {
      prepare: (sql: string) => ({
        bind: (..._args: unknown[]) => ({
          all: async () => {
            if (sql.includes("FROM routes")) {
              return {
                results: [
                  {
                    slug: "timer",
                    zone: "freeappstore.online",
                    r2_prefix: "apps/timer/",
                    store: "apps",
                    hosted_on: "r2",
                    created_at: 1000,
                    updated_at: 2000,
                  },
                  {
                    slug: "notes",
                    zone: "freeappstore.online",
                    r2_prefix: "apps/notes/",
                    store: "apps",
                    hosted_on: "r2",
                    created_at: 1000,
                    updated_at: 2000,
                  },
                ],
              };
            }
            if (sql.includes("FROM apps") && !sql.includes("FROM apps ")) {
              return {
                results: [
                  {
                    id: "timer",
                    owner_login: "serge-ivo",
                    category: "utilities",
                    type: "standalone",
                    oneliner: "Timer app",
                    repo: "freeappstore-online/timer",
                    created_at: 1000,
                  },
                ],
              };
            }
            if (sql.includes("FROM users")) {
              return {
                results: [{ github_login: "serge-ivo", avatar_url: "https://avatars.githubusercontent.com/serge-ivo" }],
              };
            }
            if (sql.includes("FROM agent_sessions") && !sql.includes("COUNT")) {
              return {
                results: [
                  {
                    session_id: "sess-123",
                    user_id: "user-1",
                    name: "My App",
                    app_id: "myapp",
                    app_url: "https://myapp.freeappstore.online",
                    deployed: 1,
                    deploy_state: '{"phase":"live"}',
                    created_at: 1000,
                    updated_at: 2000,
                  },
                  {
                    session_id: "sess-456",
                    user_id: "user-2",
                    name: "Another",
                    app_id: null,
                    app_url: null,
                    deployed: 0,
                    deploy_state: null,
                    created_at: 900,
                    updated_at: 1500,
                  },
                ],
              };
            }
            return { results: [] };
          },
          first: async () => {
            if (sql.includes("COUNT")) return { count: 2 };
            if (sql.includes("WHERE session_id")) {
              return {
                session_id: "sess-123",
                user_id: "user-1",
                name: "My App",
                app_id: "myapp",
                app_url: "https://myapp.freeappstore.online",
                deployed: 1,
                messages: JSON.stringify([
                  { role: "user", content: "build a timer" },
                  { role: "assistant", content: "Sure!" },
                ]),
                deploy_state: '{"phase":"live"}',
                created_at: 1000,
                updated_at: 2000,
              };
            }
            if (sql.includes("FROM routes WHERE slug")) {
              return { slug: "timer", zone: "freeappstore.online", hosted_on: "r2" };
            }
            return null;
          },
        }),
        all: async () => {
          if (sql.includes("FROM routes")) {
            return {
              results: [
                {
                  slug: "timer",
                  zone: "freeappstore.online",
                  r2_prefix: "apps/timer/",
                  store: "apps",
                  hosted_on: "r2",
                  created_at: 1000,
                  updated_at: 2000,
                },
                {
                  slug: "notes",
                  zone: "freeappstore.online",
                  r2_prefix: "apps/notes/",
                  store: "apps",
                  hosted_on: "r2",
                  created_at: 1000,
                  updated_at: 2000,
                },
              ],
            };
          }
          if (sql.includes("FROM apps")) {
            return {
              results: [
                {
                  id: "timer",
                  owner_login: "serge-ivo",
                  category: "utilities",
                  type: "standalone",
                  oneliner: "Timer app",
                  repo: "freeappstore-online/timer",
                  created_at: 1000,
                },
              ],
            };
          }
          if (sql.includes("FROM users")) {
            return {
              results: [{ github_login: "serge-ivo", avatar_url: "https://avatars.githubusercontent.com/serge-ivo" }],
            };
          }
          return { results: [] };
        },
        first: async () => null,
      }),
    },
    CREATORS: {
      list: async () => ({ keys: [] }),
      get: async () => null,
      put: async () => {},
    },
    ...overrides,
  };
}

// We test the endpoint logic by importing the worker and calling its fetch handler
async function callWorker(path: string, env?: ReturnType<typeof mockEnv>) {
  const { default: worker } = await import("../index.js");
  const request = new Request(`https://localhost${path}`, { method: "GET" });
  return worker.fetch(request, (env ?? mockEnv()) as any);
}

describe("/api/apps/all", () => {
  it("returns apps from routes and D1", async () => {
    // Mock fetch for registry.json calls
    const originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn(async (url: string | URL | Request) => {
      const u = typeof url === "string" ? url : url instanceof URL ? url.toString() : url.url;
      if (u.includes("registry.json") && u.includes("freeappstore")) {
        return new Response(
          JSON.stringify({
            apps: [
              {
                id: "timer",
                name: "Timer",
                category: "utilities",
                appUrl: "https://timer.freeappstore.online",
                repo: "freeappstore-online/timer",
              },
            ],
          }),
        );
      }
      if (u.includes("registry.json") && u.includes("freegamestore")) {
        return new Response(JSON.stringify({ games: [] }));
      }
      return originalFetch(url as RequestInfo, undefined);
    }) as typeof fetch;

    try {
      const res = await callWorker("/api/apps/all");
      expect(res.status).toBe(200);
      const data = (await res.json()) as any[];
      expect(data.length).toBeGreaterThanOrEqual(2);

      const timer = data.find((a: any) => a.id === "timer");
      expect(timer).toBeDefined();
      expect(timer.hostedOn).toBe("r2");
      expect(timer.inRegistry).toBe(true);
      expect(timer.owner).toBe("serge-ivo");
      expect(timer.ownerAvatar).toBe("https://avatars.githubusercontent.com/serge-ivo");

      const notes = data.find((a: any) => a.id === "notes");
      expect(notes).toBeDefined();
      expect(notes.hostedOn).toBe("r2");
      expect(notes.inRegistry).toBe(false);
      expect(notes.ownerAvatar).toBeNull();
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

describe("/api/agent/sessions", () => {
  it("returns session list", async () => {
    const res = await callWorker("/api/agent/sessions");
    expect(res.status).toBe(200);
    const data = (await res.json()) as any;
    expect(data.sessions).toHaveLength(2);
    expect(data.total).toBe(2);
    expect(data.sessions[0].sessionId).toBe("sess-123");
    expect(data.sessions[0].deployed).toBe(true);
    expect(data.sessions[1].deployed).toBe(false);
  });

  it("supports search", async () => {
    const res = await callWorker("/api/agent/sessions?q=My");
    expect(res.status).toBe(200);
  });

  it("supports pagination", async () => {
    const res = await callWorker("/api/agent/sessions?page=1");
    expect(res.status).toBe(200);
    const data = (await res.json()) as any;
    expect(data.page).toBe(1);
    expect(data.pages).toBeGreaterThanOrEqual(1);
  });
});

describe("/api/agent/sessions/:id", () => {
  it("returns session with messages", async () => {
    const res = await callWorker("/api/agent/sessions/sess-123");
    expect(res.status).toBe(200);
    const data = (await res.json()) as any;
    expect(data.sessionId).toBe("sess-123");
    expect(data.messages).toHaveLength(2);
    expect(data.messages[0].role).toBe("user");
    expect(data.messages[0].content).toBe("build a timer");
    expect(data.deployState).toEqual({ phase: "live" });
  });

  it("handles malformed deploy_state gracefully", async () => {
    const env = mockEnv();
    const origPrepare = env.DB.prepare;
    (env.DB as any).prepare = (sql: string) => {
      const stmt = origPrepare(sql);
      if (sql.includes("WHERE session_id")) {
        return {
          ...stmt,
          bind: () => ({
            ...stmt.bind(),
            first: async () => ({
              session_id: "sess-bad",
              user_id: "u1",
              name: "Bad",
              app_id: null,
              app_url: null,
              deployed: 0,
              messages: "not valid json{{{",
              deploy_state: "also broken{{{",
              created_at: 1000,
              updated_at: 2000,
            }),
          }),
        };
      }
      return stmt;
    };
    const res = await callWorker("/api/agent/sessions/sess-bad", env as any);
    expect(res.status).toBe(200);
    const data = (await res.json()) as any;
    expect(data.messages).toEqual([]);
    expect(data.deployState).toBeNull();
  });

  it("returns 404 for unknown session", async () => {
    const env = mockEnv();
    // Override the DB mock for this specific test
    const origPrepare = env.DB.prepare;
    (env.DB as any).prepare = (sql: string) => {
      const stmt = origPrepare(sql);
      if (sql.includes("WHERE session_id")) {
        return {
          ...stmt,
          bind: () => ({
            ...stmt.bind(),
            first: async () => null,
          }),
        };
      }
      return stmt;
    };
    const res = await callWorker("/api/agent/sessions/nonexistent", env as any);
    expect(res.status).toBe(404);
  });
});

describe("/api/ai-grants", () => {
  it("proxies to the backend with ADMIN_PROVISION_TOKEN", async () => {
    const { default: worker } = await import("../index.js");
    let forwardedToken = "";
    let forwardedUrl = "";
    const env = mockEnv({
      ADMIN_PROVISION_TOKEN: "admin-provision-token",
      BACKEND_FAS: {
        fetch: async (url: string | URL | Request, init?: RequestInit) => {
          forwardedUrl = typeof url === "string" ? url : url instanceof URL ? url.toString() : url.url;
          forwardedToken = new Headers(init?.headers).get("X-Internal-Token") || "";
          return new Response(JSON.stringify({ grants: [], funded: ["anthropic"] }), {
            headers: { "Content-Type": "application/json" },
          });
        },
      },
    });

    const res = await worker.fetch(new Request("https://localhost/api/ai-grants"), env as any);

    expect(res.status).toBe(200);
    expect(forwardedUrl).toBe("https://backend/v1/internal/keys/grants");
    expect(forwardedToken).toBe("admin-provision-token");
  });
});

describe("/api/apps/:id/health", () => {
  it("returns health check with route info", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn(async (url: string | URL | Request) => {
      const u = typeof url === "string" ? url : url instanceof URL ? url.toString() : url.url;
      if (u.includes("timer.freeappstore.online")) {
        return new Response("ok", { status: 200 });
      }
      if (u.includes("api.github.com")) {
        return new Response(JSON.stringify({ workflow_runs: [] }));
      }
      return originalFetch(url as RequestInfo, undefined);
    }) as typeof fetch;

    try {
      const res = await callWorker("/api/apps/timer/health");
      expect(res.status).toBe(200);
      const data = (await res.json()) as any;
      expect(data.id).toBe("timer");
      expect(data.hasRoute).toBe(true);
      expect(data.hostedOn).toBe("r2");
      expect(data.reachable).toBe(true);
      expect(data.httpStatus).toBe(200);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
