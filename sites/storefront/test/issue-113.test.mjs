/** Regression coverage for issue #113 storefront defects. */

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";

const analyticsSource = readFileSync(new URL("../analytics.js", import.meta.url), "utf8");
const authSource = readFileSync(new URL("../auth.js", import.meta.url), "utf8");
const qualitySource = readFileSync(new URL("../quality.js", import.meta.url), "utf8");
const searchSource = readFileSync(new URL("../search.js", import.meta.url), "utf8");
const storefrontSource = readFileSync(new URL("../storefront.js", import.meta.url), "utf8");
const buildSource = readFileSync(new URL("../build.js", import.meta.url), "utf8");
const styleSource = readFileSync(new URL("../style.css", import.meta.url), "utf8");

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
