import type { D1Migration } from "cloudflare:test";
import type { Env as AdminEnv } from "../../src/helpers";

declare global {
  namespace Cloudflare {
    interface Env extends AdminEnv {
      TEST_MIGRATIONS: D1Migration[];
    }
    /** Types `exports` from cloudflare:workers as this Worker's entry module. */
    interface GlobalProps {
      mainModule: typeof import("../../src/index");
    }
  }
}
