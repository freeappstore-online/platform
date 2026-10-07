/** CSP regression coverage for issue #120: shared pre-paint settings bootstrap. */

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const ROOT = resolve(dirname(__filename), "..");
const BUILD_JS = join(ROOT, "build.js");
const REGISTRY = join(ROOT, "registry.json");

function buildStorefront() {
  const tmp = mkdtempSync(join(tmpdir(), "fas-csp-120-"));
  const dist = join(tmp, "dist");
  const registry = join(tmp, "registry.json");
  writeFileSync(registry, readFileSync(REGISTRY, "utf8"));
  execFileSync(process.execPath, [BUILD_JS], {
    cwd: ROOT,
    env: { ...process.env, FAS_DIST: dist, FAS_REGISTRY_PATH: registry },
    stdio: ["ignore", "ignore", "ignore"],
    timeout: 60_000,
  });
  return { tmp, dist };
}

function htmlFiles(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const file = join(dir, entry.name);
    if (entry.isDirectory()) return htmlFiles(file);
    return entry.isFile() && entry.name.endsWith(".html") ? [file] : [];
  });
}

function executableInlineScripts(html) {
  return [...html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)].filter(([, attrs]) => {
    if (/\ssrc\s*=/i.test(attrs)) return false;
    const type = attrs.match(/\stype\s*=\s*["']([^"']+)["']/i)?.[1].trim().toLowerCase();
    return !type || type === "module" || type === "text/javascript";
  });
}

test("issue #120: every storefront inline script is byte-identical and CSP-approved", () => {
  const { tmp, dist } = buildStorefront();
  try {
    const headers = readFileSync(join(dist, "_headers"), "utf8");
    const scriptSrc = headers.match(/Content-Security-Policy: [^\n]*\bscript-src ([^;]*)/)?.[1] || "";
    assert.ok(scriptSrc.includes("'sha256-"), "the emitted CSP must hash its inline bootstrap");
    assert.ok(!scriptSrc.includes("'unsafe-inline'"), "strict CSP must not allow arbitrary inline scripts");

    const scripts = [];
    for (const file of htmlFiles(dist)) {
      const page = relative(dist, file);
      // This is an intentionally unsafe test app, not a storefront page: its
      // inline module and styles deliberately reproduce broken third-party app
      // layouts for the quality dashboard.
      if (page.startsWith(`audit-fixture${process.platform === "win32" ? "\\" : "/"}`)) continue;
      const inline = executableInlineScripts(readFileSync(file, "utf8"));
      assert.equal(inline.length, 1, `${page} must have exactly one executable inline script`);
      scripts.push(...inline.map(([, , source]) => ({ page, source })));
    }

    assert.ok(scripts.length > 20, "test must cover generated and static storefront pages");
    const distinctSources = new Set(scripts.map(({ source }) => source));
    assert.equal(distinctSources.size, 1, "all storefront pages must emit byte-identical bootstrap source");
    const source = scripts[0].source;
    assert.match(source, /stores-theme/, "bootstrap must apply the saved theme before paint");
    assert.match(source, /stores-text-size/, "bootstrap must apply the saved text size before paint");
    const hash = `sha256-${createHash("sha256").update(source).digest("base64")}`;
    assert.ok(scriptSrc.includes(`'${hash}'`), "every emitted executable inline script must match script-src");
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});
