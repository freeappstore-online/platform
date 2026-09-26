// Runtime integration tests (#7): the real host Worker in workerd with real
// D1 (this Worker's migrations applied) and R2, via `exports.default.fetch()`.
// Unit tests stay in vitest.config.ts; this suite proves the binding wiring
// they mock: D1 routes row → R2 object, and reserved subdomains → the right
// service binding.
import path from "node:path";
import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";

/** A service binding that answers with who it is and what it was asked. */
const echo = (name: string) => async (req: Request) =>
  Response.json({ binding: name, url: req.url, method: req.method, host: req.headers.get("host") });

export default defineConfig(async () => {
  const migrations = await readD1Migrations(path.join(import.meta.dirname, "migrations"));
  return {
    plugins: [
      cloudflareTest({
        wrangler: { configPath: "./wrangler.toml" },
        miniflare: {
          bindings: { TEST_MIGRATIONS: migrations },
          // The real bindings point at other deployed Workers.
          serviceBindings: { API: echo("API"), KB: echo("KB") },
          // Proxy targets (compliance.pages.dev, …) are the internet; answer locally.
          outboundService: async (req: Request) => Response.json({ outbound: req.url, method: req.method }),
        },
      }),
    ],
    test: {
      include: ["test/runtime/**/*.test.ts"],
      setupFiles: ["./test/runtime/apply-migrations.ts"],
    },
  };
});
