/** Category landing pages (/category/<slug>): slugging, grouping, page rendering and the built output. */

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const ROOT = resolve(dirname(__filename), "..");
const require = createRequire(import.meta.url);
const { categorySlug, groupCategories, categoryTitle, categoryDescription, renderCategoryPage, TITLE_MAX, DESCRIPTION_MAX, INDEX_MIN_APPS } = require("../lib/categories.cjs");

const escapeHtml = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
const categoryLabel = (cat) => (cat.toLowerCase() === "other (specify in description)" ? "Other" : cat.split("-").map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(" "));
const app = (id, category, extra = {}) => ({ id, name: id[0].toUpperCase() + id.slice(1), category, appUrl: `https://${id}.freeappstore.online`, ...extra });
const TEMPLATE = readFileSync(join(ROOT, "templates", "category.html"), "utf8");
const ldOf = (html) => JSON.parse(html.match(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/)[1]);

test("slugs: lowercase, & becomes and, spaces become dashes", () => {
  assert.equal(categorySlug("Productivity"), "productivity");
  assert.equal(categorySlug("Health & Fitness"), "health-and-fitness");
  assert.equal(categorySlug("News & Weather"), "news-and-weather");
  assert.equal(categorySlug("Brain Training"), "brain-training");
  assert.equal(categorySlug("  Odd / Name!! "), "odd-name");
});

test("grouping merges case variants, drops the Other catch-all and sorts by label", () => {
  const groups = groupCategories([
    app("a", "Lifestyle"), app("b", "lifestyle"), app("c", "Health & Fitness"),
    app("d", "Other (specify in description)"), app("e", ""), app("f", "brain-training"),
  ], categoryLabel);
  assert.deepEqual(groups.map((g) => [g.slug, g.label, g.apps.map((a) => a.id)]), [
    ["brain-training", "Brain Training", ["f"]],
    ["health-and-fitness", "Health & Fitness", ["c"]],
    ["lifestyle", "Lifestyle", ["a", "b"]],
  ]);
  assert.equal(groups[1].url, "https://freeappstore.online/category/health-and-fitness");
  assert.deepEqual(groupCategories([], categoryLabel), []);
});

test("titles and descriptions stay within SEO lengths", () => {
  for (const label of ["Productivity", "Health & Fitness", "News & Weather", "Brain Training", "An Unusually Long Category Name Here"]) {
    assert.ok(categoryTitle(label).length <= TITLE_MAX, categoryTitle(label));
    assert.ok(categoryTitle(label).endsWith("| FreeAppStore"));
    for (const n of [1, 34, 1000]) assert.ok(categoryDescription(label, n).length <= DESCRIPTION_MAX, categoryDescription(label, n));
  }
  assert.equal(categoryTitle("Productivity"), "Free Productivity Apps, No Ads or Subscriptions | FreeAppStore");
  assert.match(categoryDescription("Finance", 1), /^1 free finance app that/);
});

test("rendered page: canonical, h1, cards linking to /apps/<id>, other categories, JSON-LD ItemList", () => {
  const groups = groupCategories([app("habits", "Health & Fitness"), app("streak", "Health & Fitness"), app("notes", "Productivity")], categoryLabel);
  const health = groups.find((g) => g.slug === "health-and-fitness");
  const html = renderCategoryPage(TEMPLATE, health, groups, { escapeHtml, categoryLabel });
  assert.doesNotMatch(html, /\{\{CATEGORY_/);
  assert.match(html, /<link rel="canonical" href="https:\/\/freeappstore\.online\/category\/health-and-fitness" \/>/);
  assert.match(html, /<meta property="og:url" content="https:\/\/freeappstore\.online\/category\/health-and-fitness" \/>/);
  assert.match(html, /<h1>Free health &amp; fitness apps<\/h1>/);
  assert.match(html, /<a class="app-card compact" href="\/apps\/habits" data-id="habits">/);
  assert.match(html, /<a class="app-card compact" href="\/apps\/streak" data-id="streak">/);
  assert.doesNotMatch(html, /href="\/apps\/notes" data-id/);
  assert.match(html, /href="\/category\/productivity"/);
  assert.doesNotMatch(html, /href="\/category\/health-and-fitness"/);
  assert.match(html, /href="\/about"/);
  assert.match(html, /href="\/how-its-free"/);
  assert.match(html, /no ads, no trials and no subscriptions/);
  const ld = ldOf(html);
  assert.equal(ld["@type"], "CollectionPage");
  assert.equal(ld.url, "https://freeappstore.online/category/health-and-fitness");
  assert.deepEqual(ld.mainEntity.itemListElement, [
    { "@type": "ListItem", position: 1, url: "https://freeappstore.online/apps/habits", name: "Habits" },
    { "@type": "ListItem", position: 2, url: "https://freeappstore.online/apps/streak", name: "Streak" },
  ]);
});

test("app names and categories are escaped in HTML and JSON-LD", () => {
  const evil = "</script><img src=x onerror=alert(1)>";
  const groups = groupCategories([app("evil", "Social", { name: evil })], categoryLabel);
  const html = renderCategoryPage(TEMPLATE, groups[0], groups, { escapeHtml, categoryLabel });
  assert.doesNotMatch(html, /<img src=x/);
  assert.equal(html.match(/<\/script>/g).length, 2); // JSON-LD close + auth.js
  assert.equal(ldOf(html).mainEntity.itemListElement[0].name, evil);
});

test("build writes a page per category with public apps; sitemap lists all but thin ones", () => {
  const tmp = mkdtempSync(join(tmpdir(), "fas-category-test-"));
  try {
    const registry = JSON.parse(readFileSync(join(ROOT, "registry.json"), "utf8"));
    registry.apps.push(
      app("cat-hidden-fixture", "Zymurgy", { status: "draft", description: "hidden" }),
      app("cat-private-fixture", "Zymurgy", { private: true, description: "hidden" }),
    );
    const regPath = join(tmp, "registry.json");
    writeFileSync(regPath, JSON.stringify(registry));
    const dist = join(tmp, "dist");
    execFileSync("node", [join(ROOT, "build.js")], {
      env: { ...process.env, FAS_OFFLINE: "1", FAS_REGISTRY_PATH: regPath, FAS_DIST: dist, FAS_CF_BEACON_TOKEN: "" },
      stdio: "pipe",
    });
    const files = readdirSync(join(dist, "category")).sort();
    assert.ok(files.includes("productivity.html"));
    assert.ok(!files.includes("zymurgy.html"), "category with only hidden apps must not be built");
    assert.ok(!files.includes("other.html"));
    const sitemap = readFileSync(join(dist, "sitemap.xml"), "utf8");
    for (const f of files) {
      const slug = f.replace(/\.html$/, "");
      const html = readFileSync(join(dist, "category", f), "utf8");
      const thin = /name="robots" content="noindex, follow"/.test(html);
      assert.equal(sitemap.includes(`<loc>https://freeappstore.online/category/${slug}</loc><priority>0.8</priority>`), !thin, slug);
      assert.doesNotMatch(html, /\{\{|__CF_BEACON__/, f);
      assert.match(html, /integrity="sha256-/);
      assert.match(html, /href="\/style\.[0-9a-f]{10}\.css"/);
      assert.match(html, /<main class="container" id="main-content"/);
      assert.ok(ldOf(html).mainEntity.itemListElement.length > 0, f);
    }
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("categories under INDEX_MIN_APPS apps are noindex and the rest are indexable", () => {
  const apps = [app("solo", "Strategy"), ...Array.from({ length: INDEX_MIN_APPS }, (_, i) => app(`p${i}`, "Productivity"))];
  const groups = groupCategories(apps, categoryLabel);
  const bySlug = Object.fromEntries(groups.map((g) => [g.slug, g]));
  assert.equal(bySlug.strategy.indexable, false);
  assert.equal(bySlug.productivity.indexable, true);
  assert.match(renderCategoryPage(TEMPLATE, bySlug.strategy, groups, { escapeHtml, categoryLabel }), /<meta name="robots" content="noindex, follow" \/>/);
  assert.doesNotMatch(renderCategoryPage(TEMPLATE, bySlug.productivity, groups, { escapeHtml, categoryLabel }), /noindex/);
});
