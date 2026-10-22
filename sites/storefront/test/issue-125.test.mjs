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

function runStorefrontVotes({ token = "session-token", response = { votes: { timer: 3 }, voted: {} }, aggregate } = {}) {
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
  const windowHandlers = {};
  const status = { textContent: "", hidden: true };
  const context = {
    window: { location: { href: "https://freeappstore.online/" }, addEventListener(type, fn) { windowHandlers[type] = fn; } }, CSS: { escape: (value) => value }, localStorage: { getItem: () => token ? JSON.stringify({ token }) : null, removeItem() { token = null; } },
    document: {
      querySelector(selector) { return selector.indexOf(".app-card") === 0 ? card : null; },
      querySelectorAll(selector) { return selector.indexOf(".vote-btn") === 0 ? [button] : []; },
      getElementById(id) { return id === "vote-status" ? status : null; },
      addEventListener(type, handler) { handlers[type] = handler; },
    },
    MouseEvent: function () {}, URL, console,
    fetch(url, options = {}) {
      requests.push({ url, options });
      if (url.endsWith("/v1/store/votes")) return aggregate ? aggregate(options) : Promise.resolve({ ok: true, json: async () => response });
      return new Promise((resolve) => { resolveMutations.push(resolve); });
    },
  };
  runInNewContext(storefrontSource, context);
  return { button, card, count, context, handlers, requests, resolveMutations, status, windowHandlers, setToken(value) { token = value; } };
}

function runDetailVotes({ token = "session-token", aggregate } = {}) {
  const handlers = {};
  const windowHandlers = {};
  const button = {
    disabled: true, attributes: {}, classList: classList(),
    setAttribute(name, value) { this.attributes[name] = value; },
    addEventListener(type, fn) { handlers[type] = fn; },
  };
  const count = { textContent: "Loading…" };
  const status = { textContent: "Loading votes…" };
  const requests = [];
  const resolveMutations = [];
  const context = {
    window: { location: { href: "https://freeappstore.online/apps/timer" }, addEventListener(type, fn) { windowHandlers[type] = fn; } }, URL,
    localStorage: { getItem: () => token ? JSON.stringify({ token }) : null, removeItem() { token = null; } },
    document: {
      getElementById(id) { return { "page-data": { textContent: '{"id":"timer"}' }, "rate-vote": button, "vote-count": count, "rating-status": status }[id]; },
      querySelectorAll() { return []; },
    },
    fetch(url, options = {}) {
      requests.push({ url, options });
      if (url.endsWith("/v1/store/votes")) return aggregate ? aggregate(options) : Promise.resolve({ ok: true, json: async () => ({ votes: { timer: 3 }, voted: {} }) });
      return new Promise((resolve) => resolveMutations.push(resolve));
    },
  };
  runInNewContext(detailSource, context);
  return { button, count, status, context, handlers, requests, resolveMutations, windowHandlers, setToken(value) { token = value; } };
}

const click = (ui) => ui.handlers.click({ target: ui.button, preventDefault() {}, stopPropagation() {} });
const ok = (data) => ({ ok: true, status: 200, json: async () => data });

for (const [page, run] of [["storefront", runStorefrontVotes], ["detail", runDetailVotes]]) {
  test(`${page}: an expired session falls back to real public counts`, async () => {
    const ui = run({ aggregate: (options) => Promise.resolve(options.headers ? { ok: false, status: 401 } : ok({ votes: { timer: 8 } })) });
    await settle();
    assert.equal(ui.count.textContent, "8");
    assert.equal(ui.button.attributes["aria-pressed"], "false");
    assert.equal(ui.requests.length, 2);
    assert.equal(ui.requests[1].options.headers, undefined);
    assert.equal(ui.status.textContent.includes("unavailable"), false);
  });

  test(`${page}: API failures and malformed data never pretend to be zero votes`, async () => {
    for (const response of [{ ok: false, status: 500 }, ok({ error: "bad response" })]) {
      const ui = run({ aggregate: () => Promise.resolve(response) });
      await settle();
      assert.equal(ui.count.textContent, "Unavailable");
    }
  });

  test(`${page}: delayed OAuth hydration restores the caller's vote`, async () => {
    const ui = run({ token: null, aggregate: (options) => Promise.resolve(ok({ votes: { timer: 3 }, voted: options.headers ? { timer: true } : {} })) });
    await settle();
    ui.setToken("fresh-session");
    ui.windowHandlers["fas:auth-ready"]();
    await settle();
    assert.equal(ui.button.attributes["aria-pressed"], "true");
    click(ui);
    assert.equal(ui.requests.at(-1).options.method, "DELETE");
    ui.resolveMutations.shift()(ok({ voted: false, count: 2 }));
    await settle();
    assert.equal(ui.count.textContent, "2");
  });

  test(`${page}: expired vote saves restart sign-in instead of silently failing`, async () => {
    const ui = run();
    await settle();
    click(ui);
    ui.resolveMutations.shift()({ ok: false, status: 401 });
    await settle();
    const target = new URL(ui.context.window.location.href);
    assert.equal(target.pathname, "/v1/auth/github/start");
    assert.equal(target.searchParams.get("app_id"), "store");
    assert.equal(ui.count.textContent, "3");
    assert.equal(ui.context.localStorage.getItem("fas:session"), null);
  });

  test(`${page}: failed and rate-limited votes roll back with visible feedback`, async () => {
    for (const responseStatus of [500, 429]) {
      const ui = run();
      await settle();
      click(ui);
      ui.resolveMutations.shift()({ ok: false, status: responseStatus });
      await settle();
      assert.equal(ui.count.textContent, "3");
      assert.equal(ui.button.attributes["aria-pressed"], "false");
      assert.match(ui.status.textContent, responseStatus === 429 ? /wait a minute/ : /Could not save/);
      assert.equal(ui.button.disabled, false);
    }
  });
}

test("storefront: a slow initial count response cannot overwrite a saved vote", async () => {
  let resolveAggregate;
  const ui = runStorefrontVotes({ aggregate: () => new Promise(resolve => { resolveAggregate = resolve; }) });
  click(ui);
  ui.resolveMutations.shift()(ok({ voted: true, count: 4 }));
  await settle();
  resolveAggregate(ok({ votes: { timer: 3 }, voted: {} }));
  await settle();
  assert.equal(ui.count.textContent, "4");
  assert.equal(ui.button.attributes["aria-pressed"], "true");
});

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
