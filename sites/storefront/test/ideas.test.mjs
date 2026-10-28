/** App ideas page (/ideas): data validation, escaping, store-link pinning and the built page. */

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const ROOT = resolve(dirname(__filename), "..");
const require = createRequire(import.meta.url);
const { validateIdeas, renderIdeasPage, statusOf } = require("../lib/ideas.cjs");

const XSS = "<script>alert(1)</script>";
const escapeHtml = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");

function idea(overrides = {}) {
  return {
    id: "fixture-idea",
    name: "Fixture idea",
    category: "Utilities",
    pitch: "Everyone needs one.",
    fasEdge: "Leaders are full of ads.",
    difficulty: "easy",
    decision: "build-now",
    waitsOn: null,
    wave: 1,
    demand: 5,
    features: ["Offline"],
    caveats: null,
    fasApps: [],
    sources: ["play"],
    leaders: [
      { name: "Leader", store: "play", installs: "1B+", rating: 4.3, reviews: "795K", chartRank: null, chart: null, price: null, url: "https://play.google.com/store/apps/details?id=com.example.app" },
    ],
    ...overrides,
  };
}

test("the checked-in app-ideas.json is valid", () => {
  const data = JSON.parse(readFileSync(join(ROOT, "data", "app-ideas.json"), "utf8"));
  assert.deepEqual(validateIdeas(data), []);
  assert.ok(data.ideas.length > 0);
});

test("checked-in fasApps ids exist in the registry", () => {
  const data = JSON.parse(readFileSync(join(ROOT, "data", "app-ideas.json"), "utf8"));
  const ids = new Set(JSON.parse(readFileSync(join(ROOT, "registry.json"), "utf8")).apps.map((a) => a.id));
  const missing = data.ideas.flatMap((i) => i.fasApps.filter((id) => !ids.has(id)).map((id) => `${i.id} → ${id}`));
  assert.deepEqual(missing, []);
});

test("validation rejects bad enums, duplicates and non-store links", () => {
  assert.deepEqual(validateIdeas({ ideas: [idea()] }), []);
  assert.ok(validateIdeas({ ideas: [idea(), idea()] }).some((e) => e.includes("duplicate")));
  assert.ok(validateIdeas({ ideas: [idea({ category: "Games" })] }).some((e) => e.includes("category")));
  assert.ok(validateIdeas({ ideas: [idea({ demand: 7 })] }).some((e) => e.includes("demand")));
  for (const url of [
    "https://evil.example/store/apps/details?id=x",
    "javascript:alert(1)",
    "https://play.google.com.evil.example/store/apps/details?id=x",
    "https://apps.apple.com/us/app/x/id1\"onmouseover=\"x",
  ]) {
    const bad = idea({ leaders: [{ ...idea().leaders[0], url }] });
    assert.ok(validateIdeas({ ideas: [bad] }).some((e) => e.includes("url")), url);
  }
  const apple = idea({ leaders: [{ name: "A", store: "apple", url: "https://apps.apple.com/us/app/calculator/id1069511488" }] });
  assert.deepEqual(validateIdeas({ ideas: [apple] }), []);
});

test("status: open, covered, upgrade, defer, wont", () => {
  assert.equal(statusOf(idea(), []), "open");
  assert.equal(statusOf(idea(), [{ id: "calc" }]), "covered");
  assert.equal(statusOf(idea({ decision: "upgrade-existing" }), []), "upgrade");
  assert.equal(statusOf(idea({ decision: "defer" }), []), "defer");
  assert.equal(statusOf(idea({ decision: "wont-build" }), []), "wont");
});

test("rendering escapes text and links only live catalog apps", () => {
  const data = { researchDate: "2026-10-15", ideas: [idea({ name: XSS, pitch: XSS, leaders: [{ name: XSS, store: "apple", chartRank: 3, chart: "US Top Free" }], fasApps: ["calc", "gone"] })] };
  const tpl = "{{IDEAS_COUNT}}|{{IDEAS_OPEN_COUNT}}|{{IDEAS_READY_COUNT}}|{{IDEAS_CATEGORY_BUTTONS}}|{{IDEAS_CARDS}}|{{IDEAS_RESEARCH_DATE}}";
  const html = renderIdeasPage(tpl, data, [{ id: "calc", name: "Calc" }], escapeHtml);
  assert.ok(!html.includes(XSS));
  assert.ok(html.includes('href="/apps/calc"'));
  assert.ok(!html.includes("/apps/gone"));
  assert.ok(html.includes("#3 US Top Free"));
  assert.ok(html.startsWith("1|0|1|"), "covered idea counts as buildable, not open");
  assert.ok(!html.includes("{{"));
});

test("build writes /ideas with every idea, the script and a sitemap entry", () => {
  const tmp = mkdtempSync(join(tmpdir(), "fas-ideas-"));
  try {
    const dist = join(tmp, "dist");
    const ideasPath = join(tmp, "ideas.json");
    writeFileSync(ideasPath, JSON.stringify({ researchDate: "2026-10-15", ideas: [idea(), idea({ id: "second", name: XSS, decision: "wont-build" })] }));
    execFileSync(process.execPath, ["build.js"], {
      cwd: ROOT,
      env: { ...process.env, FAS_OFFLINE: "1", FAS_DIST: dist, FAS_IDEAS_PATH: ideasPath },
      stdio: ["ignore", "ignore", "pipe"],
      timeout: 120_000,
    });
    const html = readFileSync(join(dist, "ideas.html"), "utf8");
    assert.ok(html.includes('id="idea-fixture-idea"'));
    assert.ok(html.includes('id="idea-second"'));
    assert.ok(!html.includes(XSS));
    assert.ok(!/{{[A-Z_]+}}/.test(html), "no unsubstituted placeholders");
    assert.match(html, /<script src="\/ideas\.js\?v=[^"]+" integrity="sha256-/);
    readFileSync(join(dist, "ideas.js"));
    assert.ok(readFileSync(join(dist, "sitemap.xml"), "utf8").includes("https://freeappstore.online/ideas</loc>"));

    writeFileSync(ideasPath, JSON.stringify({ ideas: [idea({ leaders: [{ name: "x", store: "play", url: "https://evil.example/" }] })] }));
    assert.throws(() => execFileSync(process.execPath, ["build.js"], {
      cwd: ROOT,
      env: { ...process.env, FAS_OFFLINE: "1", FAS_DIST: dist, FAS_IDEAS_PATH: ideasPath },
      stdio: ["ignore", "ignore", "pipe"],
      timeout: 120_000,
    }), "a non-store link must fail the build");
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});
