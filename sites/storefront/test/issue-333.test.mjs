/** Issue #333: detail-page iframe src is the configured appUrl, not a host derived from the app id. */

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const BUILD_JS = join(ROOT, "build.js");

function app(id, extra = {}) {
  return {
    id,
    name: id[0].toUpperCase() + id.slice(1),
    category: "learning",
    icon: "&#9728;",
    iconBg: "#eff6ff",
    description: "ok",
    appUrl: `https://${id}.freeappstore.online`,
    repo: `freeappstore-online/${id}`,
    type: "standalone",
    developer: "FreeAppStore",
    ...extra,
  };
}

function build(apps) {
  const tmp = mkdtempSync(join(tmpdir(), "fas-storefront-333-"));
  const registry = join(tmp, "registry.json");
  writeFileSync(registry, JSON.stringify({ apps }));
  execFileSync(process.execPath, [BUILD_JS], {
    cwd: ROOT,
    env: { ...process.env, FAS_OFFLINE: "1", FAS_REGISTRY_PATH: registry, FAS_DIST: join(tmp, "dist") },
    stdio: ["ignore", "ignore", "ignore"],
    timeout: 60_000,
  });
  const read = (p) => readFileSync(join(tmp, "dist", p), "utf8");
  return { read, done: () => rmSync(tmp, { recursive: true, force: true }) };
}

function phoneFrameSrc(html) {
  return html.match(/<div class="phone-frame">\s*<iframe[^>]*\ssrc="([^"]+)"/)?.[1] ?? null;
}

test("custom preview hostname: Yi-shaped listing keeps appUrl, not a host derived from the id", () => {
  const { read, done } = build([
    app("hanzi-associations", {
      name: "Yi",
      appUrl: "https://yi.freeappstore.online",
    }),
    app("my-app", { name: "My App", appUrl: "https://my-app.freeappstore.online" }),
  ]);
  try {
    const custom = read("apps/hanzi-associations.html");
    assert.equal(phoneFrameSrc(custom), "https://yi.freeappstore.online");
    assert.doesNotMatch(custom, /src="https:\/\/hanzi-associations\.freeappstore\.online"/);
    assert.match(
      custom,
      /<a class="app-cta" href="https:\/\/yi\.freeappstore\.online" target="_blank" rel="noopener">Open in new tab/,
    );

    const standard = read("apps/my-app.html");
    assert.equal(phoneFrameSrc(standard), "https://my-app.freeappstore.online");

    const index = read("index.html");
    assert.match(index, /data-id="hanzi-associations"[\s\S]*?href="https:\/\/yi\.freeappstore\.online"/);
    assert.match(index, /data-id="my-app"[\s\S]*?href="https:\/\/my-app\.freeappstore\.online"/);
  } finally {
    done();
  }
});
