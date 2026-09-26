import type { D1Migration } from "cloudflare:test";
import type { Env as AgentEnv } from "../../src/index";

declare global {
  namespace Cloudflare {
    interface Env extends AgentEnv {
      TEST_MIGRATIONS: D1Migration[];
    }
    /** Types `exports` from cloudflare:workers as this Worker's entry module. */
    interface GlobalProps {
      mainModule: typeof import("../../src/index");
    }
  }
}
