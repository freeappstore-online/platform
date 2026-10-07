/** Production-CSP regression coverage for issue #122. */

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
  const tmp = mkdtempSync(join(tmpdir(), "fas-csp-122-"));
  const dist = join(tmp, "dist");
  execFileSync(process.execPath, ["build.js"], {
    cwd: ROOT,
    env: { ...process.env, FAS_DIST: dist },
    stdio: ["ignore", "ignore", "ignore"],
    timeout: 60_000,
  });
  return { tmp, dist };
}

test("issue #122: production build preserves strict CSP without inline style allowances", () => {
  const { tmp, dist } = buildStorefront();
  try {
    const headers = readFileSync(join(dist, "_headers"), "utf8");
    assert.match(headers, /style-src 'self'/);
    assert.doesNotMatch(headers, /style-src[^\n]*unsafe-inline/);

    const analyticsHtml = readFileSync(join(dist, "analytics.html"), "utf8");
    assert.doesNotMatch(analyticsHtml, /<style\b/i, "analytics styles must be external");
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("issue #122: dynamic renderers contain no CSP-blocked runtime style assignments", () => {
  const quality = readFileSync(join(ROOT, "quality.js"), "utf8");
  const analytics = readFileSync(join(ROOT, "analytics.js"), "utf8");
  const search = readFileSync(join(ROOT, "search.js"), "utf8");
  const storefront = readFileSync(join(ROOT, "storefront.js"), "utf8");

  for (const source of [quality, analytics, search, storefront]) {
    assert.doesNotMatch(source, /\.style\.(?:width|height|cursor|textDecoration)\b/);
  }
  assert.doesNotMatch(quality, /<[^>]+\sstyle=/i, "quality frames must use external viewport classes");
  assert.doesNotMatch(search, /<[^>]+\sstyle=/i, "cross-store cards must not emit inline styles");
  assert.match(quality, /q-vp-\$\{esc\(r\.id\)\}/, "quality frames need viewport classes");
  assert.match(analytics, /el\('progress'/, "rank bars should use native progress values");
  assert.match(search, /dataset\.styleId/, "cross-store cards need build-emitted color selectors");
  assert.match(storefront, /classList\.add\('storefront-card-interactive'\)/);
});

test("issue #122: external styles cover quality, analytics, and cross-store card rendering", () => {
  const css = readFileSync(join(ROOT, "style.css"), "utf8");
  const build = readFileSync(join(ROOT, "build.js"), "utf8");

  for (const viewport of ["p-320", "p-360", "p-393", "p-414", "p-600", "p-768", "p-1024", "l-568", "l-667", "l-736", "l-1024", "l-1366"]) {
    assert.match(css, new RegExp(`\\.q-vp-${viewport.replace("-", "-")}`), `missing ${viewport} preview rule`);
  }
  assert.match(css, /\.a-bar-fill::-(?:webkit|moz)-progress/);
  assert.match(css, /\.storefront-card-interactive\s*\{\s*cursor:\s*pointer/);
  assert.match(css, /\.cross-store-card\s*\{\s*text-decoration:\s*none/);
  assert.match(build, /crossStoreIconBackgrounds/, "cross-store icon colors must be emitted into card-styles.css");
  assert.match(build, /safeIconBackground/, "cross-store icon colors must be validated before CSS generation");
});
