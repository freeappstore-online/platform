/** #609: one profile button in the header, settings inside /profile, no mobile side-scroll. */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";

const read = (f) => readFileSync(new URL(`../${f}`, import.meta.url), "utf8");
const authSource = read("auth.js");

function node() {
  return {
    children: [], dataset: {}, classList: { add() {}, remove() {} }, textContent: "", innerHTML: "",
    appendChild(c) { this.children.push(c); }, replaceChildren(...c) { this.children = c; },
    setAttribute() {}, addEventListener() {},
  };
}

function render(session) {
  const navAuth = node(), account = node();
  runInNewContext(authSource, {
    document: {
      querySelectorAll: () => [], querySelector: () => null, createElement: node, documentElement: node(),
      getElementById: (id) => ({ navAuth, profileAccount: account })[id] ?? null,
    },
    window: { location: { hash: "", pathname: "/profile", search: "" } },
    localStorage: { getItem: (k) => (k === "fas:session" ? session : null), setItem() {}, removeItem() {} },
    fetch: () => new Promise(() => {}), URL,
  });
  return { navAuth, account };
}

test("header has a single account control and no settings gear", () => {
  const header = read("partials/header.html");
  assert.doesNotMatch(header, /settings/i);
  assert.match(header, /<div class="header-right">\s*<span id="navAuth"><\/span>\s*<\/div>/);
  assert.doesNotMatch(authSource, /settings-link/);
});

test("signed out: header button opens /profile, profile offers sign-in", () => {
  const { navAuth, account } = render(null);
  assert.equal(navAuth.children.length, 1);
  assert.equal(navAuth.children[0].href, "/profile");
  assert.equal(navAuth.children[0].title, "Sign in");
  assert.equal(account.children.at(-1).textContent, "Sign in with GitHub");
});

test("signed in: avatar opens /profile, profile shows the user, console and sign out", () => {
  const { navAuth, account } = render(JSON.stringify({ token: "tok", user: { id: "1", login: "creator" } }));
  assert.equal(navAuth.children[0].href, "/profile");
  const [row, actions] = account.children;
  assert.equal(row.children.at(-1).textContent, "creator");
  assert.deepEqual(actions.children.map((c) => c.textContent), ["Creator Console", "Sign out"]);
});

test("/settings redirects to /profile", () => {
  assert.match(read("_redirects"), /^\/settings \/profile 301$/m);
});

test("closed mobile drawer is hidden so it cannot widen the page", () => {
  const css = read("style.css");
  assert.match(css, /header nav \{[^}]*transform: translateX\(100%\);[^}]*visibility: hidden;/);
  assert.match(css, /header nav\.open \{[^}]*visibility: visible;/);
});

test("#610: home has no intro copy; h1 and live count are screen-reader only", () => {
  const home = read("templates/index.html");
  assert.doesNotMatch(home, /catalog-intro|Find your next everyday app/);
  assert.match(home, /<h1 class="sr-only">/);
  assert.match(home, /class="apps-count sr-only" id="apps-count" role="status"/);
});

test("#610: mobile search/sort toolbar is pinned and restarts the list on change", () => {
  const css = read("style.css");
  assert.match(css, /\.apps-section \.apps-toolbar \{\s*position: sticky;\s*top: 0;/);
  const js = read("storefront.js");
  assert.match(js, /toolbar\.addEventListener\('input', restartList\)/);
  assert.match(js, /section\.scrollIntoView\(\{ block: 'start' \}\)/);
});
