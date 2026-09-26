// Runtime integration tests (#7): the real admin Worker in workerd with real
// D1 (the backend's migrations, then the host's `routes` table, as on the
// shared `fas` database), KV and R2, via `exports.default.fetch()`. The unit
// suite (vitest.config.ts) mocks these; this one proves the wiring.
//
// The stand-ins below run in the Node process, not the test isolate, so the
// tests can't read them. Instead each one checks the credential it should be
// sent and fails loudly on a wrong one, which makes the provisioning result
// itself the proof that the right token crossed the right binding.
import path from "node:path";
import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";

export const PROVISION_TOKEN = "test-provision-token";
const GITHUB_TOKEN = "gh-test-token";
const CF_API_TOKEN = "cf-test-token";

/** Sessions the backend's /v1/auth/me knows. */
const SESSIONS: Record<string, { id: string; login: string; githubLogin: string; roles: string[] }> = {
  "Bearer admin-session": { id: "gh:99", login: "ops", githubLogin: "ops", roles: ["user", "admin"] },
  "Bearer user-session": { id: "gh:1", login: "alice", githubLogin: "alice", roles: ["user"] },
};

/** The FAS backend over the BACKEND_FAS service binding. */
async function backend(req: Request): Promise<Response> {
  const url = new URL(req.url);
  if (url.pathname === "/v1/auth/me") {
    const user = SESSIONS[req.headers.get("authorization") ?? ""];
    return user ? Response.json(user) : Response.json({ error: "invalid session" }, { status: 401 });
  }
  if (/^\/v1\/internal\/apps\/[^/]+\/analytics\/cf-token$/.test(url.pathname) && req.method === "PUT") {
    // Only the admin Worker's provisioning token may persist a site tag.
    if (req.headers.get("x-internal-token") !== PROVISION_TOKEN) return new Response("forbidden", { status: 403 });
    return Response.json({ ok: true });
  }
  return new Response("not found", { status: 404 });
}

/** GitHub + the Cloudflare API, as the admin Worker's outbound fetch sees them. */
const createdRepos = new Set<string>();
async function internet(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const auth = req.headers.get("authorization");
  if (url.hostname === "api.github.com") {
    if (auth !== `Bearer ${GITHUB_TOKEN}`) return Response.json({ message: "Bad credentials" }, { status: 401 });
    if (url.pathname.endsWith("/contents/registry.json")) {
      if (req.method === "PUT") return Response.json({ content: { sha: "new" } });
      return Response.json({ content: btoa(JSON.stringify({ apps: [] })), sha: "abc" });
    }
    if (url.pathname.includes("/collaborators/")) return new Response(null, { status: 204 });
    const create = url.pathname.match(/^\/orgs\/([^/]+)\/repos$/);
    if (create && req.method === "POST") {
      const { name } = (await req.json()) as { name: string };
      createdRepos.add(`${create[1]}/${name}`);
      return Response.json({ id: 1, name }, { status: 201 });
    }
    const repo = url.pathname.match(/^\/repos\/([^/]+\/[^/]+)$/);
    if (repo) return createdRepos.has(repo[1]) ? Response.json({ id: 1 }) : Response.json({ message: "Not Found" }, { status: 404 });
  }
  if (url.hostname === "api.cloudflare.com") {
    if (auth !== `Bearer ${CF_API_TOKEN}`) return Response.json({ success: false, errors: [{ message: "Authentication error" }] }, { status: 403 });
    if (url.pathname.endsWith("/rum/site_info/list")) return Response.json({ success: true, result: [] });
    if (url.pathname.endsWith("/rum/site_info")) return Response.json({ success: true, result: { site_tag: "tag-123" } });
  }
  return Response.json({ error: `unexpected outbound ${req.method} ${req.url}` }, { status: 599 });
}

export default defineConfig(async () => {
  const migrations = [
    ...(await readD1Migrations(path.join(import.meta.dirname, "../../packages/backend/migrations"))),
    ...(await readD1Migrations(path.join(import.meta.dirname, "../host/migrations"))),
  ];
  return {
    plugins: [
      cloudflareTest({
        wrangler: { configPath: "./wrangler.toml" },
        miniflare: {
          bindings: {
            TEST_MIGRATIONS: migrations,
            ADMIN_PROVISION_TOKEN: PROVISION_TOKEN,
            GITHUB_TOKEN,
            CF_API_TOKEN,
          },
          serviceBindings: {
            BACKEND_FAS: backend,
            AGENT: () => new Response("agent", { status: 200 }),
          },
          outboundService: internet,
        },
      }),
    ],
    test: {
      include: ["test/runtime/**/*.test.ts"],
      setupFiles: ["./test/runtime/apply-migrations.ts"],
    },
  };
});
