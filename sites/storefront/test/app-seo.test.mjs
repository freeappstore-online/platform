/** Per-app detail pages: search titles, meta descriptions, WebApplication JSON-LD and no unsupported claims. */

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(import.meta.url);
const { appSeo, displayName, seoTitle, seoDescription, truncate, applicationCategory, jsonLdObject, jsonLdScriptBody, TITLE_MAX, DESCRIPTION_MAX } =
  require("../lib/app-seo.cjs");

function app(id, extra) {
  return {
    id, name: id, category: "Utilities", icon: "&#9728;", iconBg: "#eff6ff", description: "ok",
    appUrl: `https://${id}.freeappstore.online`, repo: `freeappstore-online/${id}`,
    type: "standalone", developer: "FreeAppStore", permissions: [], ...extra,
  };
}

test("display names: lowercase slugs are capitalised, author casing is kept", () => {
  assert.equal(displayName("forktuner"), "Forktuner");
  assert.equal(displayName("periodic-table"), "Periodic Table");
  assert.equal(displayName("json"), "JSON");
  assert.equal(displayName("TypeFlow"), "TypeFlow");
  assert.equal(displayName("Meetup"), "Meetup");
});

test("titles: kind when known, generic fallback otherwise, never over the limit", () => {
  assert.equal(seoTitle(app("forktuner"), "Instrument tuner"), "Forktuner: Free Instrument Tuner, No Ads | FreeAppStore");
  assert.equal(seoTitle(app("calculator", { name: "Calculator" }), "Calculator"), "Free Calculator Online, No Ads | FreeAppStore");
  assert.equal(seoTitle(app("webshare"), null), "Webshare: Free Web App | FreeAppStore");
  // Long kind: ", No Ads" and the brand are dropped before the kind is.
  const t = seoTitle(app("prayercompass", { name: "PrayerCompass" }), "Prayer times and Qibla finder");
  assert.equal(t, "PrayerCompass: Free Prayer Times and Qibla Finder");
  assert.ok(t.length <= TITLE_MAX);
  // Absurdly long names still produce a title.
  assert.match(seoTitle(app("x", { name: "A".repeat(80) }), null), /\| FreeAppStore$/);
});

test("descriptions: trailing period, single 'Free', capitalised, cut at a word boundary", () => {
  const fork = seoDescription(app("forktuner", { description: "Free, offline tuner — mic audio never leaves your browser" }), "Instrument tuner");
  assert.equal(fork, "Free, offline tuner — mic audio never leaves your browser.");
  assert.equal((fork.match(/\bfree\b/gi) || []).length, 1);

  assert.equal(seoDescription(app("meetup", { description: "Browse local events." }), "Local events finder"),
    "Free local events finder in your browser. Browse local events.");
  assert.equal(seoDescription(app("json", { description: "JSON formatter with tree view" }), "JSON formatter"),
    "Free web app. JSON formatter with tree view.");
  assert.equal(seoDescription(app("d", { description: "  a privacy-first  tool" }), null), "Free web app. A privacy-first tool.");

  const long = seoDescription(app("l", { description: "Free " + "word ".repeat(60) }), null);
  assert.ok(long.length <= DESCRIPTION_MAX, long.length);
  assert.match(long, / word…$/);
  assert.equal(truncate("short."), "short.");
});

test("no offline or account claim is ever added", () => {
  for (const extra of [{}, { requiresAuth: true, type: "connected" }, { type: "standalone" }]) {
    const seo = appSeo(app("x", { description: "Does a thing", ...extra }), { x: "Thing doer" });
    assert.doesNotMatch(seo.description, /offline|account/i);
    assert.doesNotMatch(seo.title, /offline|account/i);
  }
});

test("JSON-LD: Google-supported category, web OS, free offer, source link, script-safe", () => {
  assert.equal(applicationCategory("Health & Fitness"), "HealthApplication");
  assert.equal(applicationCategory("lifestyle"), "LifestyleApplication");
  assert.equal(applicationCategory("Other (specify in description)"), null);

  const ld = jsonLdObject(app("forktuner", { description: "Tuner" }), { size: "62 KB" });
  assert.equal(ld["@type"], "WebApplication");
  assert.equal(ld.applicationCategory, "UtilitiesApplication");
  assert.equal(ld.operatingSystem, "Any (web browser)");
  assert.equal(ld.url, "https://forktuner.freeappstore.online");
  assert.equal(ld.isAccessibleForFree, true);
  assert.equal(ld.sameAs, "https://github.com/freeappstore-online/forktuner");
  assert.equal(ld.offers.price, "0");
  assert.equal(ld.fileSize, "62 KB");
  assert.equal(jsonLdObject(app("o", { category: "Other (specify in description)" })).applicationCategory, undefined);
  assert.equal(jsonLdObject(app("s")).fileSize, undefined);

  const evil = app("evil", { name: 'Evil "</script><script>alert(1)</script>', description: "a & b \u2028 <b>" });
  const body = jsonLdScriptBody(jsonLdObject(evil));
  assert.doesNotMatch(body, /<|>|\u2028/);
  assert.equal(JSON.parse(body).name, 'Evil "</script><script>alert(1)</script>');
});

test("app-kinds.json maps app ids to short phrases", () => {
  // Stale ids are harmless (registry.json is rewritten by provisioning), so only the shape is checked.
  const kinds = JSON.parse(readFileSync(join(ROOT, "data", "app-kinds.json"), "utf8"));
  for (const [id, kind] of Object.entries(kinds)) {
    assert.match(id, /^[a-z0-9-]+$/, `app-kinds.json: bad id ${id}`);
    assert.ok(typeof kind === "string" && kind.trim() && kind.length <= 40, `app-kinds.json: bad kind for ${id}`);
  }
});

test("built detail page uses the SEO title, description and valid JSON-LD", () => {
  const tmp = mkdtempSync(join(tmpdir(), "fas-storefront-seo-"));
  try {
    const registry = join(tmp, "registry.json");
    writeFileSync(registry, JSON.stringify({ apps: [
      app("forktuner", { description: "Free, offline tuner $& </script>" }),
      app("meetup", { name: "Meetup", category: "Social", type: "connected", requiresAuth: true, description: "Browse local events" }),
    ] }));
    execFileSync(process.execPath, [join(ROOT, "build.js")], {
      cwd: ROOT,
      env: { ...process.env, FAS_OFFLINE: "1", FAS_REGISTRY_PATH: registry, FAS_DIST: join(tmp, "dist") },
      stdio: ["ignore", "ignore", "ignore"],
      timeout: 60_000,
    });
    const read = (id) => readFileSync(join(tmp, "dist", "apps", `${id}.html`), "utf8");
    for (const id of ["forktuner", "meetup"]) {
      const html = read(id);
      assert.doesNotMatch(html, /\{\{(SEO_|JSON_LD)/);
      assert.doesNotMatch(html, /Works offline, no account needed/);
      const ld = JSON.parse(html.match(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/)[1]);
      assert.equal(ld.url, `https://${id}.freeappstore.online`);
      const title = html.match(/<title>(.*?)<\/title>/)[1];
      assert.equal(html.match(/property="og:title" content="(.*?)"/)[1], title);
      assert.equal(html.match(/property="og:description" content="(.*?)"/)[1], html.match(/name="description" content="(.*?)"/)[1]);
    }
    assert.match(read("forktuner"), /<title>Forktuner: Free Instrument Tuner, No Ads \| FreeAppStore<\/title>/);
    assert.match(read("forktuner"), /content="Free, offline tuner \$&amp; &lt;\/script&gt;\."/);
    assert.match(read("meetup"), /<title>Meetup: Free Local Events Finder, No Ads \| FreeAppStore<\/title>/);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});
