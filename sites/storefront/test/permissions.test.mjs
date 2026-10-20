/** #285: each listing shows the browser permissions its app asks for. */

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const BUILD_JS = join(ROOT, "build.js");

function app(id, extra) {
  return {
    id, name: id[0].toUpperCase() + id.slice(1), category: "learning", icon: "&#9728;", iconBg: "#eff6ff",
    description: "ok", appUrl: `https://${id}.freeappstore.online`, repo: `freeappstore-online/${id}`,
    type: "standalone", developer: "FreeAppStore", ...extra,
  };
}

function build(apps) {
  const tmp = mkdtempSync(join(tmpdir(), "fas-storefront-perms-"));
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

const section = (html) => html.match(/<section class="app-section" id="permissions">([\s\S]*?)<\/section>/)?.[1] ?? null;
const card = (html, id) => html.match(new RegExp(`<div class="app-card compact"[^>]*data-id="${id}"[\\s\\S]*?</div>\\s*<button`))?.[0] ?? "";

test("storefront permission labels cover exactly the ids compliance detects", () => {
  const compliance = readFileSync(join(ROOT, "..", "..", "packages", "compliance", "src", "lib", "permissions.ts"), "utf8");
  const ids = [...compliance.match(/PERMISSION_IDS = \[([\s\S]*?)\] as const/)[1].matchAll(/'([a-z-]+)'/g)].map((m) => m[1]);
  const build = readFileSync(BUILD_JS, "utf8");
  const labelled = [...build.match(/const PERMISSION_INFO = \{([\s\S]*?)\n\};/)[1].matchAll(/^ {2}([a-z-]+): \{/gm)].map((m) => m[1]);
  assert.ok(ids.length >= 10, "compliance ids parsed");
  assert.deepEqual(labelled, ids);
});

test("a listing shows each permission with its icon, name and the creator's reason", () => {
  const { read, done } = build([
    app("echo", { permissions: [{ name: "microphone", reason: "Live voice effects <b>now</b>" }, "camera", "made-up"] }),
  ]);
  try {
    const s = section(read("apps/echo.html"));
    assert.ok(s, "Permissions section present");
    assert.match(s, /Your browser asks before Echo can use any of these/);
    const items = [...s.matchAll(/<li class="perm-item">([\s\S]*?)<\/li>/g)].map((m) => m[1]);
    assert.equal(items.length, 2, "unknown names are dropped");
    assert.match(items[0], /<strong>Microphone<\/strong><span class="perm-reason">Live voice effects &lt;b&gt;now&lt;\/b&gt;<\/span>/, "reason shown, escaped");
    assert.match(items[1], /<strong>Camera<\/strong><span class="perm-reason">Uses your camera\.<\/span>/, "default text without a reason");
    assert.match(items[0], /class="perm-icon" aria-hidden="true">/);
  } finally {
    done();
  }
});

test("an app that needs nothing says so; an unscanned one says it isn't checked yet", () => {
  const { read, done } = build([app("plain", { permissions: [] }), app("fresh")]);
  try {
    assert.match(section(read("apps/plain.html")), /Plain doesn't ask for any permissions: no microphone, camera, location or device access\./);
    assert.match(section(read("apps/fresh.html")), /Not checked yet\./);
  } finally {
    done();
  }
});

test("cards show a compact, labelled icon row only for apps that ask for something", () => {
  const { read, done } = build([
    app("echo", { permissions: ["microphone", { name: "location", reason: "x" }] }),
    app("plain", { permissions: [] }),
  ]);
  try {
    const index = read("index.html");
    assert.match(card(index, "echo"), /<span class="app-perms" role="img" aria-label="Asks for: Microphone, Location" title="Asks for: Microphone, Location">/);
    assert.doesNotMatch(card(index, "plain"), /app-perms/);
  } finally {
    done();
  }
});

test("every app in the live registry has a permissions list (backfill)", () => {
  const registry = JSON.parse(readFileSync(join(ROOT, "registry.json"), "utf8"));
  const missing = registry.apps.filter((a) => !Array.isArray(a.permissions)).map((a) => a.id);
  assert.deepEqual(missing, []);
});
