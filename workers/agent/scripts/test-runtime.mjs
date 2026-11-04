import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

/** workerd's SQLite paths can exceed Windows MAX_PATH under an inherited,
 * deeply nested TEMP (for example a ProAgentStore browser-runner session).
 * Set both variables before starting Node: os.tmpdir()/Miniflare may cache them.
 */
export function runRuntimeTests({ platform = process.platform, env = process.env, args = [], spawn = spawnSync } = {}) {
  let directory;
  try {
    let childEnv = env;
    if (platform === "win32") {
      const base = env.LOCALAPPDATA ? path.join(env.LOCALAPPDATA, "Temp") : tmpdir();
      mkdirSync(base, { recursive: true });
      directory = mkdtempSync(path.join(base, "fas-"));
      childEnv = { ...env, TEMP: directory, TMP: directory };
      console.log(`Runtime test temp directory: ${directory}`);
    }
    const require = createRequire(import.meta.url);
    const cli = path.join(path.dirname(require.resolve("vitest/package.json")), "vitest.mjs");
    const result = spawn(process.execPath, [cli, "run", "--config", "vitest.runtime.ts", ...args], {
      cwd: fileURLToPath(new URL("../", import.meta.url)),
      env: childEnv,
      stdio: "inherit",
    });
    if (result.error) throw result.error;
    return result.status ?? 1;
  } finally {
    if (directory) rmSync(directory, { recursive: true, force: true });
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = runRuntimeTests({ args: process.argv.slice(2) });
}
