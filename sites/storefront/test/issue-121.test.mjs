/** Cache-versioning regression coverage for issue #121. */

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const ROOT = resolve(dirname(__filename), "..");
const BUILD_JS = join(ROOT, "build.js");
const REGISTRY = join(ROOT, "registry.json");
const STYLE = join(ROOT, "style.css");

function buildStorefront({ styleSuffix = "", cardColor } = {}) {
  const tmp = mkdtempSync(join(tmpdir(), "fas-cache-121-"));
  const dist = join(tmp, "dist");
  const registryPath = join(tmp, "registry.json");
  const stylePath = join(tmp, "style.css");
  const registry = JSON.parse(readFileSync(REGISTRY, "utf8"));
  if (cardColor) registry.apps[0].iconBg = cardColor;
  writeFileSync(registryPath, JSON.stringify(registry));
  writeFileSync(stylePath, readFileSync(STYLE, "utf8") + styleSuffix);
  execFileSync(process.execPath, [BUILD_JS], {
    cwd: ROOT,
    env: {
      ...process.env,
      FAS_DIST: dist,
      FAS_REGISTRY_PATH: registryPath,
      FAS_STYLE_CSS_PATH: stylePath,
    },
    stdio: ["ignore", "ignore", "ignore"],
    timeout: 60_000,
  });
  return { tmp, dist };
}

function stylesheetUrls(dist) {
  const html = readFileSync(join(dist, "index.html"), "utf8");
  const style = html.match(/href="\/(style\.[a-f0-9]{10}\.css)"/);
  const cardStyles = html.match(/href="\/(card-styles\.[a-f0-9]{10}\.css)"/);
  assert.ok(style, "index.html must use a fingerprinted style.css URL");
  assert.ok(cardStyles, "index.html must use a fingerprinted card-styles.css URL");
  return { style: style[1], cardStyles: cardStyles[1], html };
}

test("issue #121: CSS URLs change when their content changes", () => {
  const first = buildStorefront();
  const second = buildStorefront({
    styleSuffix: "\n/* issue-121 stylesheet version fixture */\n",
    cardColor: "#123456",
  });
  try {
    const firstUrls = stylesheetUrls(first.dist);
    const secondUrls = stylesheetUrls(second.dist);
    assert.notEqual(firstUrls.style, secondUrls.style, "style.css content must change its URL");
    assert.notEqual(firstUrls.cardStyles, secondUrls.cardStyles, "card stylesheet content must change its URL");
    assert.equal(readFileSync(join(first.dist, firstUrls.style), "utf8"), readFileSync(STYLE, "utf8"));
    assert.match(readFileSync(join(second.dist, secondUrls.cardStyles), "utf8"), /#123456/);
  } finally {
    rmSync(first.tmp, { recursive: true, force: true });
    rmSync(second.tmp, { recursive: true, force: true });
  }
});

test("issue #121: immutable CSS headers name only fingerprinted stylesheet paths", () => {
  const { tmp, dist } = buildStorefront();
  try {
    const urls = stylesheetUrls(dist);
    const headers = readFileSync(join(dist, "_headers"), "utf8");
    for (const url of [urls.style, urls.cardStyles]) {
      assert.match(
        headers,
        new RegExp(`/${url.replace(".", "\\.")}\\n  Cache-Control: public, max-age=31536000, immutable`),
        `${url} must receive an immutable cache header`,
      );
    }
    assert.doesNotMatch(headers, /^\/\*\.css$/m, "a wildcard must not make unversioned CSS immutable");
    assert.doesNotMatch(headers, /^\/(?:style|card-styles)\.css$/m, "unversioned stylesheet URLs must not be immutable");
    assert.ok(!headers.includes("/style.css\n  Cache-Control: public, max-age=31536000, immutable"));
    assert.ok(!headers.includes("/card-styles.css\n  Cache-Control: public, max-age=31536000, immutable"));
    assert.equal(existsSync(join(dist, "style.css")), false, "legacy style.css must not be deployed");
    assert.equal(existsSync(join(dist, "card-styles.css")), false, "legacy card-styles.css must not be deployed");
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});
