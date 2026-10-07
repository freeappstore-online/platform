/**
 * Security regression tests for the freeappstore store site.
 * Run with: node --test security.test.mjs
 * (Uses Node.js built-in test runner — zero dependencies.)
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";

// ── HTML escaping ──

// Exercise the production escaping function, rather than a test-only copy.
const searchSource = readFileSync(new URL('./search.js', import.meta.url), 'utf8');
const escSource = searchSource.slice(searchSource.indexOf('  function esc(s)'), searchSource.indexOf('  function categoryLabel'));
const esc = runInNewContext(`${escSource}; esc`);

function node() {
  return {
    children: [], dataset: {}, style: {}, classList: { add() {}, remove() {} },
    textContent: '', innerHTML: '', hidden: false,
    appendChild(child) { this.children.push(child); },
    replaceChildren() { this.children = []; },
    setAttribute() {}, addEventListener() {}, querySelectorAll() { return []; },
  };
}

function searchCard(item, domain = 'freegamestore.online', path = 'games') {
  const elements = Object.fromEntries(['storefront-search', 'apps-grid', 'search-empty', 'cross-store-results', 'cross-store-grid', 'cross-store-registry'].map(id => [id, node()]));
  elements['cross-store-registry'].textContent = JSON.stringify({ items: [item], domain, path });
  runInNewContext(searchSource, {
    document: { getElementById: id => elements[id], createElement: node },
    window: { location: { href: 'https://freeappstore.online/?q=needle' } }, URL,
  });
  return elements['cross-store-grid'].children[0];
}

async function authCallback(hash, response = { ok: true, status: 200, json: async () => ({ id: '1', login: '<img src=x onerror=alert(1)>' }) }, session = null) {
  const avatar = node();
  const calls = [], stored = [], cleared = [];
  runInNewContext(readFileSync(new URL('./auth.js', import.meta.url), 'utf8'), {
    document: { querySelectorAll: () => [], querySelector: selector => selector === '.header-right' ? node() : null, getElementById: () => avatar, createElement: node, documentElement: node() },
    window: { location: { hash, pathname: '/', search: '' } },
    history: { replaceState: (...args) => cleared.push(args) },
    localStorage: { getItem: key => key === 'fas:session' ? session : null, setItem: (...args) => stored.push(args), removeItem() {} },
    fetch: async (...args) => { calls.push(args); return response; }, URL,
  });
  await new Promise(resolve => setImmediate(resolve));
  return { avatar, calls, stored, cleared };
}

const XSS_PAYLOADS = [
  '<script>alert(1)</script>',
  '<img onerror=alert(1) src=x>',
  '"><svg onload=alert(1)>',
  '<iframe src="javascript:alert(1)">',
  '<a href="javascript:void(0)" onclick="alert(1)">',
  '${alert(1)}',
  '{{constructor.constructor("return this")()}}',
  '<details open ontoggle=alert(1)>',
  '<math><mtext><table><mglyph><style><!--</style><img src=x onerror=alert(1)>',
];

describe("HTML escaping covers all XSS payloads", () => {
  for (const payload of XSS_PAYLOADS) {
    it(`neutralizes: ${payload.slice(0, 50)}`, () => {
      const escaped = esc(payload);
      // No raw HTML tags should remain
      assert.ok(!/<[a-z]/i.test(escaped), `Raw HTML tag found in: ${escaped}`);
    });
  }
});

// ── search.js has esc() and uses it ──

describe("search.js security", () => {
  const searchJs = readFileSync("search.js", "utf-8");

  it("defines esc() function", () => {
    assert.ok(searchJs.includes("function esc(s)"), "search.js missing esc() function");
  });

  it("escapes item.name", () => {
    assert.ok(searchJs.includes("${esc(item.name)}"), "item.name not escaped");
  });

  it("renders malicious card fields safely using the current card layout", () => {
    for (const payload of XSS_PAYLOADS) {
      const card = searchCard({ id: 'needle/../x', name: payload, description: payload, icon: payload, iconBg: payload, category: 'needle' });
      assert.ok(card);
      assert.ok(card.innerHTML.includes(esc(payload)));
      assert.ok(!card.innerHTML.includes(payload) || esc(payload) === payload);
      assert.doesNotMatch(card.innerHTML, /\sstyle\s*=/i, "cross-store cards must not emit inline styles");
      assert.ok(card.href.endsWith('/games/needle%2F..%2Fx.html'));
      assert.equal(card.rel, 'noopener');
    }
  });

  it("escapes the derived letter and category without emitting inline colors", () => {
    const card = searchCard({ id: 'needle', name: '<svg>', category: 'needle<img>', iconBg: '#abc' });
    assert.match(card.innerHTML, />&lt;<\/div>/);
    assert.match(card.innerHTML, /Needle&lt;img&gt;/);
    assert.doesNotMatch(card.innerHTML, /\sstyle\s*=/i);
  });

  it("rejects CSS declaration injection", () => {
    const card = searchCard({ id: 'needle', name: 'Needle', category: 'test', iconBg: 'red; background: url(https://evil.example/track)' });
    assert.doesNotMatch(card.innerHTML, /\sstyle\s*=/i);
    assert.ok(!card.innerHTML.includes('evil.example'));
  });

  it("rejects unexpected registry destinations", () => {
    for (const domain of ['evil.example', 'freegamestore.online@evil.example', 'freegamestore.online/../evil']) {
      assert.equal(searchCard({ id: 'needle' }, domain), undefined);
    }
    assert.equal(searchCard({ id: 'needle' }, 'freegamestore.online', '..'), undefined);
  });
});

// ── quality.js has esc() and uses it ──

describe("quality.js security", () => {
  const qualityJs = readFileSync("quality.js", "utf-8");

  it("defines esc() function", () => {
    assert.ok(qualityJs.includes("function esc(s)"), "quality.js missing esc() function");
  });

  it("escapes app names in summary", () => {
    assert.ok(qualityJs.includes("${esc(a.name"), "a.name not escaped in summary");
  });

  it("validates postMessage origin", () => {
    assert.ok(
      qualityJs.includes("e.origin !== expectedOrigin"),
      "postMessage handler missing origin check",
    );
  });
});

// ── auth.js uses safe DOM APIs ──
// Reads the source file (build.js just copies it to dist/ verbatim).
// Pre-2026-05-20 this test read dist/auth.js, but dist/ is now a
// gitignored build artifact so source-of-truth is at the repo root.

describe("auth.js security", () => {
  const authJs = readFileSync("auth.js", "utf-8");

  it("does not use innerHTML with user data", () => {
    // Every HTML assignment must be a complete static string literal.
    // This allows the settings SVG without allowing concatenated user data.
    const assignments = [...authJs.matchAll(/\.innerHTML\s*=\s*([^\n]+)/g)];
    assert.ok(assignments.length > 0);
    for (const [, value] of assignments) {
      assert.match(value, /^(?:"[^"\n]*"|'[^'\n]*');\s*$/);
    }
  });

  it("uses Bearer token auth (not cookies)", () => {
    assert.ok(authJs.includes("Bearer"), "Should use Bearer token auth");
  });

  it("uses /v1/auth/me endpoint", () => {
    assert.ok(authJs.includes("/v1/auth/me"), "Should use /v1/auth/me");
  });

  it("clears hash after OAuth callback", () => {
    assert.ok(authJs.includes("replaceState"), "Should clear hash via replaceState");
  });
});

describe("OAuth and cached-session regressions", () => {
  it("strips malformed and invalid callback tokens without sending them", async () => {
    for (const token of ['%E0%A4%A', 'bad%0D%0Aheader', '', 'x'.repeat(1025)]) {
      const result = await authCallback('#fas_session=' + token);
      assert.equal(result.cleared.length, 1);
      assert.equal(result.calls.length, 0);
      assert.equal(result.stored.length, 0);
      assert.equal(result.avatar.children[0].textContent, 'Sign in');
    }
  });
  it("does not cache a user from a failed authentication response", async () => {
    const result = await authCallback('#fas_session=valid-token', { ok: false, status: 401, json: async () => ({ id: '1' }) });
    assert.equal(result.stored.length, 0);
    assert.equal(result.avatar.children[0].textContent, 'Sign in');
  });
  it("uses Bearer auth, clears the callback, and renders user data as text", async () => {
    const result = await authCallback('#fas_session=valid-token');
    assert.equal(result.calls[0][1].headers.Authorization, 'Bearer valid-token');
    assert.equal(result.cleared.length, 1);
    assert.equal(result.stored.length, 1);
    assert.equal(result.avatar.children[0].textContent, '<img src=x onerror=alert(1)>');
    assert.equal(result.avatar.children[0].innerHTML, '');
  });
  it("rejects unsafe cached tokens before fetch", async () => {
    const result = await authCallback('', undefined, JSON.stringify({ token: 'bad\r\nheader', user: { id: '1' } }));
    assert.equal(result.calls.length, 0);
    assert.equal(result.avatar.children[0].textContent, 'Sign in');
  });
});

// ── app-detail template has sandbox ──

describe("app-detail.html security", () => {
  const template = readFileSync("templates/app-detail.html", "utf-8");

  it("iframe has sandbox attribute", () => {
    assert.ok(template.includes('sandbox="allow-scripts allow-same-origin"'), "Missing sandbox on iframe");
  });

  it("iframe has referrerpolicy", () => {
    assert.ok(template.includes('referrerpolicy="no-referrer"'), "Missing referrerpolicy");
  });
});

// ── audit-fixture escapes reflected input ──

describe("audit-fixture security", () => {
  const fixture = readFileSync("audit-fixture/fixture.js", "utf-8");

  it("escapes scenario parameter before innerHTML", () => {
    assert.ok(
      fixture.includes("safeScenario") || fixture.includes("escapeHtml") || fixture.includes("replace(/</g"),
      "scenario parameter should be escaped before insertion",
    );
  });
});
