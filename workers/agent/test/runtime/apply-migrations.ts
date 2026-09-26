import { applyD1Migrations } from "cloudflare:test";
import { env } from "cloudflare:workers";

// Idempotent: D1 records applied migrations, so each test file can run it.
await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
