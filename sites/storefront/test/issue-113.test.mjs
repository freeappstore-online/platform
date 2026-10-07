/** Regression coverage for issue #113 storefront defects. */

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { runInNewContext } from "node:vm";

const analyticsSource = readFileSync(new URL("../analytics.js", import.meta.url), "utf8");
const authSource = readFileSync(new URL("../auth.js", import.meta.url), "utf8");
const qualitySource = readFileSync(new URL("../quality.js", import.meta.url), "utf8");
const searchSource = readFileSync(new URL("../search.js", import.meta.url), "utf8");
const storefrontSource = readFileSync(new URL("../storefront.js", import.meta.url), "utf8");
const detailSource = readFileSync(new URL("../detail-page.js", import.meta.url), "utf8");
const buildSource = readFileSync(new URL("../build.js", import.meta.url), "utf8");
const styleSource = readFileSync(new URL("../style.css", import.meta.url), "utf8");
const qualityTemplate = readFileSync(new URL("../templates/quality.html", import.meta.url), "utf8");
const aiDir = new URL("../ai/", import.meta.url);

function node() {
  return {
    children: [], classList: { add() {}, remove() {}, toggle() {} },
    appendChild(child) { this.children.push(child); },
    replaceChildren(...children) { this.children = children; },
    addEventListener() {}, setAttribute() {},
  };
}

test("analytics reads the bearer token from auth.js's fas:session object", async () => {
  const requests = [];
  const root = node();
  runInNewContext(analyticsSource, {
    document: { getElementById: () => root, createElement: node },
    localStorage: { getItem: (key) => key === "fas:session" ? JSON.stringify({ token: "session-token", user: { id: "1" } }) : null },
    location: { search: "" },
    window: { addEventListener() {} },
    URLSearchParams,
    fetch: async (...args) => {
      requests.push(args);
      return { ok: true, json: async () => ({ apps: [] }) };
    },
    setTimeout() {},
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(requests[0][0], "https://api.freeappstore.online/v1/apps/mine");
  assert.equal(requests[0][1].headers.Authorization, "Bearer session-token");
});

test("auth dispatches fas:auth-ready after an OAuth session is confirmed", async () => {
  const events = [];
  const navAuth = node();
  function BrowserEvent(type) { this.type = type; }
  runInNewContext(authSource, {
    document: {
      querySelectorAll: () => [], querySelector: () => null,
      getElementById: () => navAuth, createElement: node, documentElement: node(),
    },
    window: {
      location: { hash: "#fas_session=valid-token", pathname: "/", search: "", href: "https://freeappstore.online/analytics.html" },
      dispatchEvent: (event) => events.push(event.type),
    },
    Event: BrowserEvent,
    history: { replaceState() {} },
    localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
    fetch: async () => ({ ok: true, status: 200, json: async () => ({ id: "1", login: "creator" }) }),
    URL,
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(events, ["fas:auth-ready"]);
});

test("analytics renders API-derived dashboard values with DOM nodes, not HTML sinks", () => {
  assert.doesNotMatch(analyticsSource, /\.innerHTML\s*=/, "analytics must not interpolate API data into HTML");
  assert.match(analyticsSource, /title\.textContent/, "chart titles should use textContent");
  assert.match(analyticsSource, /node\.replaceChildren\.apply/, "live paths should be assembled from DOM nodes");
});

test("quality dashboard disposes the prior message listener and timeout before a rerender", () => {
  assert.match(qualitySource, /cleanupDetail\(\);/, "each detail rerender should clean up the prior render");
  assert.match(qualitySource, /window\.removeEventListener\('message', handler\)/, "message listener should be removed");
  assert.match(qualitySource, /window\.clearTimeout\(timeoutId\)/, "report timeout should be cleared");
});

test("search and category filtering update the visible result count", () => {
  assert.match(searchSource, /__fasUpdateAppsCount\(localShown\)/, "search should publish its filtered count");
  assert.match(storefrontSource, /function updateAppsCount\(shown\)/, "storefront should own count rendering");
  assert.match(storefrontSource, /updateAppsCount\(shown\)/, "category filtering should publish its filtered count");
});

test("desktop app cards expose keyboard button semantics and activate on Enter or Space", () => {
  assert.match(buildSource, /class="app-card compact" role="button" tabindex="0"/, "generated card needs button semantics");
  assert.match(storefrontSource, /e\.key !== 'Enter' && e\.key !== ' '/, "card should handle Enter and Space");
  assert.match(storefrontSource, /card\.click\(\)/, "keyboard activation should use the same card action");
});

test("mobile drawer traps focus, restores it, and closes with Escape", () => {
  assert.match(authSource, /aria-expanded/, "menu trigger should expose its state");
  assert.match(authSource, /e\.key === "Escape"/, "drawer should close on Escape");
  assert.match(authSource, /lastFocused\.focus\(\)/, "drawer should restore trigger focus");
  assert.match(authSource, /e\.key !== "Tab"/, "drawer should handle Tab focus wrapping");
});

test("settings controls wrap and stack before they can overflow a narrow viewport", () => {
  assert.match(styleSource, /\.setting-control\s*\{[\s\S]*?flex-wrap:\s*wrap/, "settings controls should wrap");
  assert.match(styleSource, /\.setting-control :is\(input, select, button\).*max-width:\s*100%/, "controls should be width constrained");
  assert.match(styleSource, /@media \(max-width: 480px\)[\s\S]*?\.setting-row \{[^}]*flex-direction:\s*column/, "settings rows should stack on narrow screens");
});

test("generated AI guides contain no inline styles or event handlers", () => {
  for (const file of readdirSync(aiDir).filter((name) => name.endsWith(".html"))) {
    const html = readFileSync(join(aiDir.pathname, file), "utf8");
    assert.doesNotMatch(html, /\sstyle\s*=/i, `${file} must not emit inline style attributes`);
    assert.doesNotMatch(html, /\sonclick\s*=/i, `${file} must not emit inline click handlers`);
    assert.doesNotMatch(html, /<style\b/i, `${file} must not emit inline style blocks`);
  }
});

test("AI guides expose shared-build placeholders for shell, beacon, SRI, and versioning", () => {
  const html = readFileSync(join(aiDir.pathname, "codex.html"), "utf8");
  assert.match(html, /\{\{HEADER\}\}/, "guide source should request the shared header");
  assert.match(html, /\{\{FOOTER\}\}/, "guide source should request the shared footer");
  assert.match(html, /__CF_BEACON__/, "guide source should request the analytics beacon");
  assert.match(html, /ai-guide\.js\?v=\{\{VER_AI_GUIDE_JS\}\}.*\{\{SRI_AI_GUIDE_JS\}\}/, "guide source should request a versioned, integrity-protected interaction script");
  assert.match(buildSource, /processStaticHtml\(fs\.readFileSync\(source, 'utf8'\), `ai\/\$\{f\}`\)/, "build should process AI guides through the static HTML pipeline");
});

test("quality controls use radio semantics and expose an initial checked state", () => {
  assert.match(qualityTemplate, /id="q-store-tabs" role="radiogroup"/, "store controls should be a radio group");
  assert.match(qualityTemplate, /data-store="apps" class="active" aria-checked="true"/, "Apps should be initially checked in source markup");
  assert.match(qualityTemplate, /id="q-mode-tabs" role="radiogroup"/, "mode controls should be a radio group");
  assert.match(qualityTemplate, /data-mode="all" class="active" aria-checked="true"/, "All viewports should be initially checked in source markup");
});

test("quality summary activates the valid store from the URL", () => {
  function button(store) {
    const attributes = {};
    return {
      dataset: { store },
      attributes,
      classList: { toggle() {} },
      setAttribute(name, value) { attributes[name] = value; },
    };
  }
  const apps = button("apps");
  const games = button("games");
  const tabs = { querySelectorAll: () => [apps, games], addEventListener() {} };
  const elements = {
    "q-registry": { textContent: '{"apps":[],"games":[]}' },
    "q-summary-list": { innerHTML: "" },
    "q-summary-view": {},
    "q-detail-view": {},
    "q-store-tabs": tabs,
  };
  runInNewContext(qualitySource, {
    document: { getElementById: (id) => elements[id] },
    location: { search: "?store=games", pathname: "/quality.html", hash: "" },
    URLSearchParams,
    history: { pushState() {} },
  });
  assert.equal(games.attributes["aria-checked"], "true");
  assert.equal(apps.attributes["aria-checked"], "false");
});

test("app detail voting uses the shared authenticated vote API, never local-only ratings", () => {
  assert.doesNotMatch(detailSource, /fas_ratings_|fas_voted_/, "detail votes must not use localStorage rating keys");
  assert.match(detailSource, /\/v1\/store\/votes/, "detail page loads public aggregate vote counts");
  assert.match(detailSource, /\/v1\/store\/apps\/.*\/vote/, "detail page submits through the established vote route");
  assert.match(detailSource, /method: nextVoted \? "POST" : "DELETE"/, "detail page toggles authenticated votes");
  assert.match(detailSource, /triggerSignIn\(\)/, "detail page redirects unauthenticated voters");
  assert.match(detailSource, /Could not save your vote/, "detail page rolls back and reports a save failure");
  assert.match(detailSource, /Vote count unavailable/, "detail page visibly reports unavailable aggregate counts");
});

test("creator analytics list requests one batch summary instead of per-app stats", () => {
  assert.match(analyticsSource, /call\('\/v1\/analytics\/summary\?days=7'\)/, "list should request the batch summary");
  assert.doesNotMatch(analyticsSource, /call\('\/v1\/apps\/' \+ encodeURIComponent\(app\.id\) \+ '\/analytics\/stats\?days=7'\)/, "list must not request one stats report per app");
});

test("unavailable vote and live analytics data is visibly reported", () => {
  assert.match(storefrontSource, /function showVoteCountsUnavailable\(\)/, "aggregate vote failure needs a visible handler");
  assert.match(storefrontSource, /Vote count unavailable\. You can still vote\./, "vote failure should not masquerade as zero");
  assert.match(analyticsSource, /Live analytics unavailable\./, "live analytics failure should be visible");
});
