import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Copy source outside the checkout so ancestor node_modules cannot hide a
// dependency imported from the shared CLI/compliance/backend source tree.
const root = fileURLToPath(new URL("../../../", import.meta.url));
const isolated = mkdtempSync(path.join(tmpdir(), "fas-agent-isolation-"));
try {
  const tracked = spawnSync("git", ["ls-files", "-z"], { cwd: root, encoding: "utf8" });
  if (tracked.status !== 0) throw new Error(tracked.stderr || "git ls-files failed");
  for (const file of tracked.stdout.split("\0").filter(Boolean)) {
    const target = path.join(isolated, file);
    mkdirSync(path.dirname(target), { recursive: true });
    copyFileSync(path.join(root, file), target);
  }
  const worker = path.join(isolated, "workers/agent");
  symlinkSync(realpathSync(path.join(root, "workers/agent/node_modules")), path.join(worker, "node_modules"), "junction");
  const require = createRequire(import.meta.url);
  if (process.argv.includes("--checks")) {
    const commands = [
      [path.join(path.dirname(require.resolve("typescript/package.json")), "bin/tsc"), "--noEmit"],
      [path.join(path.dirname(require.resolve("vitest/package.json")), "vitest.mjs"), "run"],
      [path.join(worker, "scripts/test-runtime.mjs")],
    ];
    for (const args of commands) {
      const check = spawnSync(process.execPath, args, { cwd: worker, stdio: "inherit", env: { ...process.env, NODE_PATH: "" } });
      if (check.error) throw check.error;
      if (check.status !== 0) throw new Error(`Isolated check failed: ${args.join(" ")}`);
    }
  }
  const cli = path.join(path.dirname(require.resolve("wrangler/package.json")), "bin/wrangler.js");
  const result = spawnSync(process.execPath, [cli, "deploy", "--dry-run", "--outdir", path.join(isolated, "bundle")], {
    cwd: worker,
    env: { ...process.env, NODE_PATH: "", WRANGLER_SEND_METRICS: "false" },
    stdio: "inherit",
  });
  if (result.error) throw result.error;
  process.exitCode = result.status ?? 1;
} finally {
  rmSync(isolated, { recursive: true, force: true });
}
