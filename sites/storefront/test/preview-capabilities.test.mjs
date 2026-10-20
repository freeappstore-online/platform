/**
 * Storefront previews get every capability the app host grants (#284).
 *
 * Owner decision (2026-10-20): the storefront preview must work too. The
 * storefront's Permissions-Policy allows each feature for itself and the
 * *.freeappstore.online app origins, and every preview iframe delegates the
 * features with `allow`. That replaced the #272 "mic isn't available in the
 * preview" banner, which is retired.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const ROOT = resolve(dirname(__filename), "..");
const BUILD_JS = join(ROOT, "build.js");
const HOST_TS = join(ROOT, "..", "..", "workers", "host", "src", "host.ts");

const MIC_APPS = ["echoshift", "voicerecorder", "flatbed", "forktuner", "soundboard-pro"];

/** The features the app host grants each app on its own origin. */
function hostFeatures() {
  const src = readFileSync(HOST_TS, "utf8");
  const list = src.match(/PERMISSIONS_POLICY_SELF = \[([\s\S]*?)\] as const/)?.[1];
  assert.ok(list, "host.ts must export PERMISSIONS_POLICY_SELF");
  return [...list.matchAll(/"([a-z-]+)"/g)].map((m) => m[1]);
}

function validApp(overrides) {
  return {
    id: "valid-app",
    name: "Valid",
    category: "learning",
    icon: "&#9728;",
    iconBg: "#eff6ff",
    description: "ok",
    appUrl: "https://valid.freeappstore.online",
    repo: "freeappstore-online/valid",
    cfProject: "valid",
    type: "standalone",
    developer: "FreeAppStore",
    ...overrides,
  };
}

function runBuild(apps) {
  const tmp = mkdtempSync(join(tmpdir(), "fas-storefront-preview-"));
  const registry = join(tmp, "registry.json");
  const dist = join(tmp, "dist");
  writeFileSync(registry, JSON.stringify({ apps }, null, 2));
  execFileSync(process.execPath, [BUILD_JS], {
    cwd: ROOT,
    env: { ...process.env, FAS_OFFLINE: "1", FAS_REGISTRY_PATH: registry, FAS_DIST: dist },
    stdio: ["ignore", "ignore", "ignore"],
    timeout: 60_000,
  });
  return { tmp, dist };
}

const allowOf = (html, marker) => {
  const tag = html.match(new RegExp(`<iframe[^>]*${marker}[^>]*>`))?.[0] ?? "";
  return { tag, allow: (tag.match(/allow="([^"]*)"/)?.[1] ?? "").split("; ").filter(Boolean) };
};

test("registry still marks known microphone apps (#272 data)", () => {
  const registry = JSON.parse(readFileSync(join(ROOT, "registry.json"), "utf8"));
  const byId = Object.fromEntries(registry.apps.map((app) => [app.id, app]));
  for (const id of MIC_APPS) assert.equal(byId[id]?.microphone, true, `${id} must declare microphone`);
  assert.notEqual(byId.calculator?.microphone, true, "non-mic apps must not declare microphone");
});

test("preview iframes delegate every host capability, and the storefront policy lets them through", () => {
  const features = hostFeatures();
  assert.ok(features.includes("microphone") && features.length >= 30, "host feature list parsed");
  const { tmp, dist } = runBuild([
    validApp({ id: "echoshift", name: "echoshift", appUrl: "https://echoshift.freeappstore.online", microphone: true }),
    validApp({ id: "calculator", name: "Calculator", appUrl: "https://calculator.freeappstore.online" }),
  ]);
  try {
    const listing = readFileSync(join(dist, "apps", "echoshift.html"), "utf8");
    const indexHtml = readFileSync(join(dist, "index.html"), "utf8");
    const quality = readFileSync(join(dist, "quality.html"), "utf8");
    const headers = readFileSync(join(dist, "_headers"), "utf8");

    // Listing page and homepage split-pane preview.
    for (const [name, frame] of [
      ["listing", allowOf(listing, 'src="https://echoshift')],
      ["homepage", allowOf(indexHtml, 'id="previewFrame"')],
    ]) {
      assert.deepEqual(frame.allow, features, `${name} preview must delegate exactly the host features`);
      // Without allow-same-origin the framed app gets an opaque origin, which
      // never matches the delegation allowlist (and loses its own storage).
      assert.match(frame.tag, /sandbox="[^"]*allow-same-origin/, `${name} preview keeps allow-same-origin`);
    }

    // /quality frames are built client-side from the embedded registry.
    const qualityData = JSON.parse(quality.match(/id="q-registry">([^<]*)</)[1]);
    assert.deepEqual(qualityData.previewAllow.split("; "), features, "quality frames delegate the host features");
    assert.match(readFileSync(join(ROOT, "quality.js"), "utf8"), /allow="\$\{esc\(loadRegistry\(\)\.previewAllow/);

    // Storefront policy: each feature for self + app origins, Topics API blocked.
    const pp = headers.match(/Permissions-Policy: ([^\n]*)/)?.[1] ?? "";
    for (const f of features) {
      assert.ok(pp.split(", ").includes(`${f}=(self "https://*.freeappstore.online")`), `storefront policy must allow ${f}`);
    }
    assert.deepEqual(pp.split(", ").filter((e) => e.endsWith("=()")), ["browsing-topics=()"]);

    // The #272 banner is retired; the Open in new tab link stays.
    for (const html of [listing, indexHtml]) {
      assert.ok(!html.includes("preview-banner"), "no capability banner");
      assert.ok(!html.includes("isn't available in the preview"), "no 'not available in the preview' copy");
    }
    assert.match(
      listing,
      /<a class="app-cta" href="https:\/\/echoshift\.freeappstore\.online" target="_blank" rel="noopener">Open in new tab/,
      "Open in new tab link must remain on the listing",
    );
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});
