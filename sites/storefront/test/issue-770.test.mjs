/** #770: loading vote counts under ?sort=popular re-sorts without scrolling the list back to the top. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";

const storefrontSource = readFileSync(new URL("../storefront.js", import.meta.url), "utf8");

function el(props = {}) {
  const handlers = {};
  return {
    dataset: {}, attributes: {}, parent: null,
    classList: { toggle() {}, add() {}, remove() {} },
    setAttribute(k, v) { this.attributes[k] = v; },
    getAttribute(k) { return this.attributes[k] ?? null; },
    removeAttribute(k) { delete this.attributes[k]; },
    addEventListener(type, h) { (handlers[type] ||= []).push(h); },
    // Bubbles through the parent chain, like a real DOM event.
    dispatchEvent(e) {
      for (let n = this; n; n = n.parent) for (const h of n.handlers[e.type] || []) h({ type: e.type, target: this });
    },
    closest(sel) { return sel === ".filter-btn" && this.isFilterBtn ? this : null; },
    handlers,
    ...props,
  };
}

test("#770: vote counts re-apply the popular sort without a click that scrolls to the top", async () => {
  const toolbar = el();
  const sortBar = el({ parent: toolbar });
  const buttons = ["newest", "popular", "az"].map((sort) => el({ parent: sortBar, isFilterBtn: true, dataset: { sort } }));
  sortBar.querySelectorAll = () => buttons;
  sortBar.querySelector = (sel) => buttons.find((b) => sel.includes(`"${b.dataset.sort}"`)) || null;

  const cards = ["a", "b", "c"].map((id) => {
    const card = el({ dataset: { votes: "0" } });
    card.attributes["data-id"] = id;
    const count = el({ textContent: "0" });
    const vote = el({ dataset: { appId: id }, closest: (sel) => (sel === ".app-card" ? card : null), querySelector: () => count });
    card.vote = vote;
    return card;
  });
  const grid = el({ order: [...cards] });
  grid.querySelectorAll = () => [...grid.order];
  grid.appendChild = (c) => { grid.order = grid.order.filter((x) => x !== c).concat(c); };

  let scrolled = 0;
  const section = el({ getBoundingClientRect: () => ({ top: -500 }), scrollIntoView() { scrolled++; } });
  const elements = { sortBar, "apps-grid": grid, apps: section };

  let resolveVotes;
  const votesLoaded = new Promise((r) => { resolveVotes = r; });
  const window = { location: { href: "https://freeappstore.online/?sort=popular" }, matchMedia: () => ({ matches: false }), addEventListener() {} };
  runInNewContext(storefrontSource, {
    window, URL, Node: { TEXT_NODE: 3 }, CSS: { escape: (v) => v },
    history: { replaceState() {} }, setTimeout() { return 1; }, clearTimeout() {},
    MouseEvent: function (type) { this.type = type; },
    getComputedStyle: (n) => ({ position: n === toolbar ? "sticky" : "static" }),
    localStorage: { getItem: () => null },
    document: {
      addEventListener() {},
      getElementById: (id) => elements[id] || null,
      querySelector: (sel) => (sel === ".apps-toolbar" ? toolbar : null),
      querySelectorAll: (sel) => (sel.startsWith(".vote-btn") ? cards.map((c) => c.vote) : []),
    },
    fetch: (url) => {
      if (!url.endsWith("/v1/store/votes")) return new Promise(() => {});
      setImmediate(resolveVotes);
      return Promise.resolve({ ok: true, json: async () => ({ votes: { c: 5, b: 2 }, voted: {} }) });
    },
  });

  await votesLoaded;
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(grid.order.map((c) => c.attributes["data-id"]), ["c", "b", "a"], "list is re-sorted by the loaded counts");
  assert.equal(scrolled, 0, "a visitor who has scrolled must not be jumped back to the top");
});
