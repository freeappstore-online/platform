/** Interaction regression coverage for issue #124 app-card votes. */

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";

const storefrontSource = readFileSync(new URL("../storefront.js", import.meta.url), "utf8");

function classList() {
  const classes = new Set();
  return {
    add(name) { classes.add(name); },
    remove(name) { classes.delete(name); },
    toggle(name, on) { if (on) classes.add(name); else classes.delete(name); },
    has(name) { return classes.has(name); },
  };
}

function event(target, key) {
  return {
    target, key, prevented: false, stopped: false,
    preventDefault() { this.prevented = true; },
    stopPropagation() { this.stopped = true; },
  };
}

function runStorefront({ desktop = true } = {}) {
  const documentHandlers = {};
  const cardHandlers = {};
  const requests = [];
  const card = {
    dataset: { id: "timer", about: "/apps/timer", votes: "2" },
    classList: classList(),
    addEventListener(type, handler) { cardHandlers[type] = handler; },
    querySelector(selector) {
      if (selector === ".app-cta") return { getAttribute: () => "https://timer.freeappstore.online" };
      if (selector === ".app-name") return { firstChild: { nodeType: 3, textContent: "Timer" }, textContent: "Timer" };
      if (selector === ".vote-count") return count;
      return null;
    },
  };
  const count = { textContent: "2", setAttribute() {}, removeAttribute() {} };
  const vote = {
    dataset: { appId: "timer" }, classList: classList(), disabled: false, attributes: {},
    closest(selector) { return selector === ".vote-btn" ? this : (selector === ".app-card" ? card : null); },
    querySelector(selector) { return selector === ".vote-count" ? count : null; },
    setAttribute(name, value) { this.attributes[name] = value; },
    removeAttribute(name) { delete this.attributes[name]; },
  };
  const pane = { classList: classList() };
  const frame = { classList: classList(), addEventListener() {}, removeEventListener() {}, removeAttribute() {}, hidden: true };
  const empty = { classList: classList(), querySelector: () => null, hidden: false };
  const title = { innerHTML: "", appendChild() {} };
  const toolbarButton = { hidden: true, addEventListener() {} };
  const modeBar = { hidden: true, addEventListener() {}, querySelectorAll: () => [] };
  const elements = { previewPane: pane, previewFrame: frame, previewEmpty: empty, previewTitle: title, previewNewTab: toolbarButton, previewAbout: toolbarButton, previewClose: toolbarButton, previewModeBar: modeBar };
  const location = { href: "https://freeappstore.online/" };
  const context = {
    Node: { TEXT_NODE: 3 }, URL, history: { replaceState() {} }, setTimeout() { return 1; }, clearTimeout() {},
    localStorage: { getItem: () => JSON.stringify({ token: "session-token" }) },
    window: { matchMedia: () => ({ matches: desktop }), location },
    CSS: { escape: (value) => value },
    document: {
      addEventListener(type, handler, capture) { (documentHandlers[type] ||= []).push({ handler, capture: !!capture }); },
      getElementById(id) { return elements[id] || null; },
      querySelector(selector) { return selector.startsWith(".app-card") ? card : null; },
      querySelectorAll(selector) {
        if (selector === "#apps-grid .app-card.compact") return [card];
        if (selector.startsWith(".vote-btn")) return [vote];
        return [];
      },
      createTextNode() { return {}; }, createElement() { return { className: "", textContent: "" }; },
    },
    fetch(url, options = {}) {
      requests.push({ url, options });
      if (url.endsWith("/v1/store/votes")) return Promise.resolve({ ok: true, json: async () => ({ votes: { timer: 2 }, voted: {} }) });
      if (url.includes("/vote")) return new Promise(() => {});
      return Promise.resolve({ ok: true });
    },
  };
  runInNewContext(storefrontSource, context);
  return { card, vote, cardHandlers, documentHandlers, requests, location };
}

function captureHandler(ui, type) {
  return ui.documentHandlers[type].find(({ capture }) => capture).handler;
}

test("issue #124: vote click and touch/pointer gestures never activate the desktop preview", () => {
  const ui = runStorefront({ desktop: true });
  for (const type of ["pointerdown", "touchstart"]) {
    const pointerEvent = event(ui.vote);
    captureHandler(ui, type)(pointerEvent);
    assert.equal(pointerEvent.stopped, true, `${type} must not reach a card`);
  }
  const click = event(ui.vote);
  captureHandler(ui, "click")(click);
  assert.equal(click.prevented, true);
  assert.equal(click.stopped, true);
  assert.equal(ui.card.classList.has("is-active"), false, "vote must not open the preview");
  assert.equal(ui.requests.filter(({ url }) => url.includes("/apps/")).length, 1, "vote request should still be made");
});

test("issue #124: vote keyboard click and mobile fallback cannot navigate, but card body can", () => {
  const mobile = runStorefront({ desktop: false });
  const cardKeydown = event(mobile.vote, "Enter");
  mobile.cardHandlers.keydown(cardKeydown);
  assert.equal(cardKeydown.prevented, false, "the card must leave native vote-button keyboard behavior alone");

  // Enter/Space on a native button synthesize a click; capture it before the card.
  const voteClick = event(mobile.vote);
  captureHandler(mobile, "click")(voteClick);
  assert.equal(mobile.location.href, "https://freeappstore.online/");
  assert.equal(mobile.requests.filter(({ url }) => url.includes("/apps/")).length, 1);

  const bodyClick = event(mobile.card);
  mobile.card.closest = () => null;
  mobile.cardHandlers.click(bodyClick);
  assert.equal(mobile.location.href, "/apps/timer", "ordinary card activation must still navigate on mobile");
});

test("issue #124: direct card fallback also rejects a vote target while ordinary desktop activation opens preview", () => {
  const ui = runStorefront({ desktop: true });
  const voteEvent = event(ui.vote);
  ui.cardHandlers.click(voteEvent);
  assert.equal(voteEvent.prevented, true);
  assert.equal(ui.card.classList.has("is-active"), false);

  const bodyEvent = event(ui.card);
  ui.card.closest = () => null;
  ui.cardHandlers.click(bodyEvent);
  assert.equal(ui.card.classList.has("is-active"), true, "ordinary card activation must still open preview");
});
