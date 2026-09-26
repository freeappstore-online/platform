// Runtime integration tests (#7): the real agent Worker in workerd with its
// real SQLite-backed Durable Object and D1 (the backend's migrations), via
// `exports.default.fetch()`. The unit suite (vitest.config.ts) mocks these;
// this one proves the entry → PLATFORM binding → Durable Object → D1 chain.
//
// The stand-ins run in the Node process, so tests prove their effects through
// the Worker's responses and D1, not by inspecting them.
import path from "node:path";
import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";

/** Sessions the platform backend knows, and what its key vault resolves for each. */
const USERS: Record<string, { user: Record<string, unknown>; resolved: Record<string, unknown> }> = {
  "Bearer alice-session": {
    user: { id: "gh:1", login: "alice", githubLogin: "alice", roles: ["user"] },
    resolved: { key: null, source: "none" },
  },
  "Bearer bob-session": {
    user: { id: "gh:2", login: "bob", githubLogin: "bob", roles: ["user"] },
    resolved: { key: null, source: "grant_unfunded", provider: "anthropic", model: "claude-sonnet-4-6" },
  },
};

/** The FAS backend over the PLATFORM service binding. */
async function platform(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const who = USERS[req.headers.get("authorization") ?? ""];
  if (!who) return Response.json({ error: "invalid session" }, { status: 401 });
  if (url.pathname === "/v1/auth/me") return Response.json(who.user);
  if (url.pathname.startsWith("/v1/keys/resolve-agent/")) return Response.json(who.resolved);
  return new Response("not found", { status: 404 });
}

/** GitHub, for /import: one small app repo. */
const REPO: Record<string, string> = {
  "web/src/App.tsx": "export default function App() { return <main>Dictionary</main>; }",
  "package.json": '{ "name": "dict" }',
};
async function internet(req: Request): Promise<Response> {
  const url = new URL(req.url);
  if (url.hostname === "api.github.com") {
    if (url.pathname === "/repos/freeappstore-online/dict/git/trees/main") {
      return Response.json({ tree: Object.entries(REPO).map(([p, c]) => ({ path: p, type: "blob", size: c.length })) });
    }
    const file = url.pathname.match(/^\/repos\/freeappstore-online\/dict\/contents\/(.+)$/);
    if (file && REPO[file[1]] !== undefined) return new Response(REPO[file[1]]);
  }
  return Response.json({ error: `unexpected outbound ${req.method} ${req.url}` }, { status: 599 });
}

export default defineConfig(async () => {
  const migrations = await readD1Migrations(path.join(import.meta.dirname, "../../packages/backend/migrations"));
  return {
    plugins: [
      cloudflareTest({
        wrangler: { configPath: "./wrangler.toml" },
        miniflare: {
          bindings: { TEST_MIGRATIONS: migrations, GITHUB_TOKEN: "gh-test-token" },
          serviceBindings: { PLATFORM: platform },
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
