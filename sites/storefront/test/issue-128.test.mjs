/** Navigation regression coverage for issue #128: the custom 404 page. */

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const ROOT = resolve(dirname(__filename), "..");

function buildStorefront() {
  const tmp = mkdtempSync(join(tmpdir(), "fas-navigation-128-"));
  const dist = join(tmp, "dist");
  execFileSync(process.execPath, ["build.js"], {
    cwd: ROOT,
    env: { ...process.env, FAS_OFFLINE: "1", FAS_DIST: dist },
    stdio: ["ignore", "ignore", "ignore"],
    timeout: 60_000,
  });
  return { tmp, dist };
}

function navigationHref(html, label) {
  const escapedLabel = label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return html.match(new RegExp(`<a\\b[^>]*\\bhref=["']([^"']+)["'][^>]*>\\s*${escapedLabel}\\s*</a>`, "i"))?.[1];
}

test("issue #128: built 404 Guidelines navigation uses the deployed extensionless redirect", () => {
  const { tmp, dist } = buildStorefront();
  try {
    const notFound = readFileSync(join(dist, "404.html"), "utf8");
    const redirects = readFileSync(join(dist, "_redirects"), "utf8");

    assert.equal(navigationHref(notFound, "Guidelines"), "/guidelines");
    assert.match(redirects, /^\/guidelines\s+https:\/\/docs\.freeappstore\.online\/\s+301$/m);
    assert.doesNotMatch(notFound, /href=["']\/guidelines\.html["']/i);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});
