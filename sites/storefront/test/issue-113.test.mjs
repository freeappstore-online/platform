/** Regression coverage for issue #113 storefront defects. */

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";

const analyticsSource = readFileSync(new URL("../analytics.js", import.meta.url), "utf8");
const authSource = readFileSync(new URL("../auth.js", import.meta.url), "utf8");

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
