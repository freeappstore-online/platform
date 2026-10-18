/** Coverage for issue #272: microphone-blocked preview banner. */

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { runInNewContext } from "node:vm";

const __filename = fileURLToPath(import.meta.url);
const ROOT = resolve(dirname(__filename), "..");
const BUILD_JS = join(ROOT, "build.js");
const storefrontSource = readFileSync(join(ROOT, "storefront.js"), "utf8");

const BANNER_COPY =
  "This app uses your microphone, which isn't available in the preview. Open it in a new tab to use it.";

const MIC_APPS = ["echoshift", "voicerecorder", "flatbed", "forktuner", "soundboard-pro"];

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
  const tmp = mkdtempSync(join(tmpdir(), "fas-storefront-272-"));
  const registry = join(tmp, "registry.json");
  const dist = join(tmp, "dist");
  writeFileSync(registry, JSON.stringify({ apps }, null, 2));
  execFileSync(process.execPath, [BUILD_JS], {
    cwd: ROOT,
    env: {
      ...process.env,
      FAS_OFFLINE: "1",
      FAS_REGISTRY_PATH: registry,
      FAS_DIST: dist,
    },
    stdio: ["ignore", "ignore", "ignore"],
    timeout: 60_000,
  });
  return { tmp, dist };
}

test("issue #272: registry marks known microphone apps", () => {
  const registry = JSON.parse(readFileSync(join(ROOT, "registry.json"), "utf8"));
  const byId = Object.fromEntries(registry.apps.map((app) => [app.id, app]));
  for (const id of MIC_APPS) {
    assert.equal(byId[id]?.microphone, true, `${id} must declare microphone`);
  }
  assert.notEqual(byId.calculator?.microphone, true, "non-mic apps must not declare microphone");
});

test("issue #272: listing preview shows the mic banner only for microphone apps", () => {
  const { tmp, dist } = runBuild([
    validApp({ id: "echoshift", name: "echoshift", appUrl: "https://echoshift.freeappstore.online", microphone: true }),
    validApp({ id: "calculator", name: "Calculator", appUrl: "https://calculator.freeappstore.online" }),
  ]);
  try {
    const micPage = readFileSync(join(dist, "apps", "echoshift.html"), "utf8");
    const plainPage = readFileSync(join(dist, "apps", "calculator.html"), "utf8");
    const indexHtml = readFileSync(join(dist, "index.html"), "utf8");
    const headers = readFileSync(join(dist, "_headers"), "utf8");

    assert.ok(micPage.includes(`class="preview-banner"`), "mic listing must include the banner");
    assert.ok(micPage.includes(BANNER_COPY), "mic listing must use the accepted banner copy");
    assert.match(
      micPage,
      /<a class="app-cta" href="https:\/\/echoshift\.freeappstore\.online" target="_blank" rel="noopener">Open in new tab/,
      "existing Open in new tab link must remain on the listing",
    );
    assert.match(
      micPage,
      /allow="clipboard-write; fullscreen"/,
      "listing iframe must keep its current allow list",
    );
    assert.doesNotMatch(micPage, /allow="[^"]*microphone/, "listing iframe must not delegate microphone");

    assert.ok(!plainPage.includes(`class="preview-banner"`), "non-mic listing must omit the banner");
    assert.ok(!plainPage.includes(BANNER_COPY), "non-mic listing must not show the mic copy");

    assert.match(
      indexHtml,
      /data-id="echoshift"[^>]*data-microphone="1"/,
      "homepage card for a mic app must carry data-microphone",
    );
    assert.doesNotMatch(
      indexHtml,
      /data-id="calculator"[^>]*data-microphone/,
      "homepage card for a non-mic app must not carry data-microphone",
    );
    assert.match(
      indexHtml,
      /id="previewMicBanner"[^>]*hidden/,
      "homepage preview banner must exist and start hidden",
    );
    assert.ok(indexHtml.includes(BANNER_COPY), "homepage preview banner uses the accepted copy");

    assert.match(headers, /Permissions-Policy:[^\n]*microphone=\(\)/, "storefront lockdown must stay in place");
    assert.doesNotMatch(headers, /microphone=\(self\)/, "storefront must not start delegating microphone");
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

function classList() {
  const classes = new Set();
  return {
    add(name) { classes.add(name); },
    remove(name) { classes.delete(name); },
    toggle(name, on) { if (on) classes.add(name); else classes.delete(name); },
    has(name) { return classes.has(name); },
  };
}

function event(target) {
  return {
    target, prevented: false, stopped: false,
    preventDefault() { this.prevented = true; },
    stopPropagation() { this.stopped = true; },
  };
}

function runStorefront({ microphone = false, requiresAuth = false } = {}) {
  const cardHandlers = {};
  const micBanner = { hidden: true };
  const card = {
    dataset: {
      id: microphone ? "echoshift" : "timer",
      about: microphone ? "/apps/echoshift" : "/apps/timer",
      microphone: microphone ? "1" : undefined,
      requiresAuth: requiresAuth ? "1" : undefined,
    },
    classList: classList(),
    addEventListener(type, handler) { cardHandlers[type] = handler; },
    querySelector(selector) {
      if (selector === ".app-cta") {
        return { getAttribute: () => microphone
          ? "https://echoshift.freeappstore.online"
          : "https://timer.freeappstore.online" };
      }
      if (selector === ".app-name") {
        return { firstChild: { nodeType: 3, textContent: microphone ? "echoshift" : "Timer" }, textContent: microphone ? "echoshift" : "Timer" };
      }
      return null;
    },
    closest() { return null; },
  };
  const pane = { classList: classList() };
  const frame = { classList: classList(), addEventListener() {}, removeEventListener() {}, removeAttribute() {}, hidden: true };
  const empty = { classList: classList(), querySelector: () => null, hidden: false };
  const title = { innerHTML: "", appendChild() {} };
  const toolbarButton = { hidden: true, addEventListener() {} };
  const modeBar = { hidden: true, addEventListener() {}, querySelectorAll: () => [] };
  const elements = {
    previewPane: pane,
    previewFrame: frame,
    previewEmpty: empty,
    previewTitle: title,
    previewNewTab: toolbarButton,
    previewAbout: toolbarButton,
    previewClose: toolbarButton,
    previewModeBar: modeBar,
    previewMicBanner: micBanner,
  };
  const context = {
    Node: { TEXT_NODE: 3 }, URL, history: { replaceState() {} }, setTimeout() { return 1; }, clearTimeout() {},
    localStorage: { getItem: () => null },
    window: { matchMedia: () => ({ matches: true }), location: { href: "https://freeappstore.online/" } },
    CSS: { escape: (value) => value },
    document: {
      addEventListener() {},
      getElementById(id) { return elements[id] || null; },
      querySelector() { return null; },
      querySelectorAll(selector) {
        if (selector === "#apps-grid .app-card.compact") return [card];
        if (selector.startsWith(".vote-btn")) return [];
        if (selector.startsWith(".app-card.compact.is-active")) return [];
        return [];
      },
      createTextNode() { return {}; },
      createElement() { return { className: "", textContent: "" }; },
    },
    fetch() { return Promise.resolve({ ok: true }); },
  };
  runInNewContext(storefrontSource, context);
  return { card, cardHandlers, micBanner };
}

test("issue #272: homepage preview shows the mic banner for microphone apps and hides it otherwise", () => {
  const mic = runStorefront({ microphone: true });
  mic.cardHandlers.click(event(mic.card));
  assert.equal(mic.micBanner.hidden, false, "mic app preview must show the banner");

  const plain = runStorefront({ microphone: false });
  plain.cardHandlers.click(event(plain.card));
  assert.equal(plain.micBanner.hidden, true, "non-mic app preview must keep the banner hidden");
});
