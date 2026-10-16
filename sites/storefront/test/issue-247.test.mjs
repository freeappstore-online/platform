/** Regression coverage for issue #247: the delisted instrument-tuner page redirects to forktuner. */

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const ROOT = resolve(dirname(__filename), "..");

function buildStorefront() {
  const tmp = mkdtempSync(join(tmpdir(), "fas-storefront-247-"));
  const dist = join(tmp, "dist");
  execFileSync(process.execPath, ["build.js"], {
    cwd: ROOT,
    env: { ...process.env, FAS_OFFLINE: "1", FAS_DIST: dist },
    stdio: ["ignore", "ignore", "ignore"],
    timeout: 60_000,
  });
  return { tmp, dist };
}

test("issue #247: instrument-tuner stays delisted and its old page redirects to forktuner", () => {
  const registry = JSON.parse(readFileSync(join(ROOT, "registry.json"), "utf8"));
  const ids = new Set(registry.apps.map((app) => app.id));
  assert.ok(!ids.has("instrument-tuner"), "instrument-tuner must not be listed (its repo is empty)");
  assert.ok(ids.has("forktuner"), "the redirect target must be listed");

  const { tmp, dist } = buildStorefront();
  try {
    const redirects = readFileSync(join(dist, "_redirects"), "utf8");
    assert.match(redirects, /^\/apps\/instrument-tuner\s+\/apps\/forktuner\s+301$/m);
    assert.match(redirects, /^\/apps\/instrument-tuner\.html\s+\/apps\/forktuner\s+301$/m);
    // A built page would shadow the redirect on Pages.
    assert.ok(!existsSync(join(dist, "apps", "instrument-tuner.html")));
    assert.ok(existsSync(join(dist, "apps", "forktuner.html")));
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});
