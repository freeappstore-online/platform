/** Regression coverage for issue #125 vote hydration. */

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";

const storefrontSource = readFileSync(new URL("../storefront.js", import.meta.url), "utf8");
const detailSource = readFileSync(new URL("../detail-page.js", import.meta.url), "utf8");

function classList() {
  const classes = new Set();
  return { toggle(name, on) { if (on) classes.add(name); else classes.delete(name); }, has(name) { return classes.has(name); } };
}

function flush() {
  return new Promise((resolve) => setImmediate(resolve));
}

async function settle() {
  await flush();
  await flush();
}

function runStorefrontVotes({ token = "session-token", response = { votes: { timer: 3 }, voted: {} } } = {}) {
  const card = { dataset: { id: "timer", votes: "0" }, querySelector: () => count };
  const button = {
    dataset: { appId: "timer" }, classList: classList(), disabled: false, attributes: {},
    setAttribute(name, value) { this.attributes[name] = value; },
    removeAttribute(name) { delete this.attributes[name]; },
    querySelector(selector) { return selector === ".vote-count" ? count : null; },
    closest(selector) { return selector === ".app-card" ? card : (selector === ".vote-btn" ? this : null); },
  };
  const count = { textContent: "0", setAttribute() {}, removeAttribute() {} };
  const handlers = {};
  const requests = [];
  const resolveMutations = [];
  const context = {
    window: {}, CSS: { escape: (value) => value }, localStorage: { getItem: () => token ? JSON.stringify({ token }) : null },
    document: {
      querySelector(selector) { return selector.indexOf(".app-card") === 0 ? card : null; },
      querySelectorAll(selector) { return selector.indexOf(".vote-btn") === 0 ? [button] : []; },
      getElementById() { return null; },
      addEventListener(type, handler) { handlers[type] = handler; },
    },
    MouseEvent: function () {}, URL, console,
    fetch(url, options = {}) {
      requests.push({ url, options });
      if (url.endsWith("/v1/store/votes")) return Promise.resolve({ ok: true, json: async () => response });
      return new Promise((resolve) => { resolveMutations.push(resolve); });
    },
  };
  runInNewContext(storefrontSource, context);
  return { button, card, count, context, handlers, requests, resolveMutations };
}

test("storefront hydrates an existing authenticated vote after reload", async () => {
  const ui = runStorefrontVotes({ response: { votes: { timer: 3 }, voted: { timer: true } } });
  await settle();
  assert.equal(ui.context.window.__fasVotedApps.timer, true);
  assert.equal(ui.button.attributes["aria-pressed"], "true");
  assert.equal(ui.button.classList.has("voted"), true);
  assert.equal(ui.requests[0].options.headers.Authorization, "Bearer session-token");
});

test("storefront adds then removes votes and serializes concurrent clicks", async () => {
  const ui = runStorefrontVotes();
  await settle();
  ui.handlers.click({ target: ui.button, preventDefault() {}, stopPropagation() {} });
  ui.handlers.click({ target: ui.button, preventDefault() {}, stopPropagation() {} });
  assert.equal(ui.requests.filter((request) => request.url.includes("/apps/")).length, 1);
  assert.equal(ui.requests.at(-1).options.method, "POST");
  ui.resolveMutations.shift()({ ok: true, json: async () => ({ voted: true, count: 4 }) });
  await settle();
  assert.equal(ui.button.attributes["aria-pressed"], "true");
  ui.handlers.click({ target: ui.button, preventDefault() {}, stopPropagation() {} });
  assert.equal(ui.requests.at(-1).options.method, "DELETE");
  ui.resolveMutations.shift()({ ok: true, json: async () => ({ voted: false, count: 3 }) });
  await settle();
  assert.equal(ui.button.attributes["aria-pressed"], "false");
});

test("storefront requests aggregate-only data anonymously", async () => {
  const ui = runStorefrontVotes({ token: null });
  await settle();
  assert.equal(Object.keys(ui.requests[0].options).length, 0);
  assert.equal(ui.button.attributes["aria-pressed"], "false");
});

test("detail page hydrates the same private caller state before toggling", () => {
  assert.match(detailSource, /hydrationToken \? \{ headers: \{ Authorization: "Bearer " \+ hydrationToken \} \} : \{\}/);
  assert.match(detailSource, /data\.voted && data\.voted\[APP_ID\] === true/);
  assert.match(detailSource, /method: nextVoted \? "POST" : "DELETE"/);
});
