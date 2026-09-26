import type { D1Migration } from "cloudflare:test";
import type { Env as HostEnv } from "../../src/host";

declare global {
  namespace Cloudflare {
    interface Env extends HostEnv {
      TEST_MIGRATIONS: D1Migration[];
    }
    /** Types `exports` from cloudflare:workers as this Worker's entry module. */
    interface GlobalProps {
      mainModule: typeof import("../../src/index");
    }
  }
}
