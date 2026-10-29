/** App ideas page (/ideas): data + capability validation, computed verdicts, cross-links, escaping and the built page. */

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
const { validateIdeas, validateCapabilities, renderIdeasPage, verdictFor, statusOf, CAPABILITY_IDS } = require("../lib/ideas.cjs");

const XSS = "<script>alert(1)</script>";
const escapeHtml = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
const readJson = (p) => JSON.parse(readFileSync(join(ROOT, p), "utf8"));

function caps(platform, overrides = {}) {
  const capabilities = Object.fromEntries(CAPABILITY_IDS.map((id) => [id, { status: "yes", limits: null, note: null, evidence: [] }]));
  for (const [id, status] of Object.entries(overrides)) capabilities[id] = { status, limits: status === "limited" ? `${id} quota` : null, note: null, evidence: [] };
  return { platform, name: platform === "fas" ? "FreeAppStore" : "ProAppStore", verifiedAt: "2026-10-29", capabilities };
}
const FAS = caps("fas", { "scheduled-jobs": "no", payments: "no", "file-storage": "no", "user-storage": "limited" });
const PAS = caps("pas");

function idea(overrides = {}) {
  return {
    id: "fixture-idea", name: "Fixture idea", category: "Utilities", pitch: "Everyone needs one.", fasEdge: "Leaders are full of ads.",
    difficulty: "easy", decision: "build-now", waitsOn: null, wave: 1, demand: 5, features: ["Offline"], caveats: null,
    requires: [], anyOf: null, optional: [], requiresWhy: null, heldBy: null, fasApps: [], pasApps: [], sources: ["play"],
    leaders: [{ name: "Leader", store: "play", installs: "1B+", rating: 4.3, reviews: "795K", chartRank: null, chart: null, price: null, url: "https://play.google.com/store/apps/details?id=com.example.app" }],
    ...overrides,
  };
}
const here = (key, c, apps = []) => ({
  key, name: c.name, caps: c, apps, appsField: `${key}Apps`, appHref: (id) => `/apps/${id}`,
  initCommand: (id) => `${key} init ${id}`, buildHint: "hint", edgeLabel: "Edge:",
});
const other = (c) => ({ key: c.platform, name: c.name, caps: c, ideasUrl: `https://${c.platform}.example/ideas` });
const withApps = (h) => ({ ...h, appsById: new Map(h.apps.map((a) => [a.id, a])) });

test("checked-in ideas and both capability manifests are valid", () => {
  const data = readJson("data/app-ideas.json");
  assert.deepEqual(validateIdeas(data), []);
  assert.deepEqual(validateCapabilities(readJson("data/capabilities.json")), []);
  assert.deepEqual(validateCapabilities(readJson("data/pas-capabilities.json")), []);
  assert.ok(data.ideas.length > 0);
});

test("checked-in fasApps ids exist in the registry", () => {
  const data = readJson("data/app-ideas.json");
  const ids = new Set(readJson("registry.json").apps.map((a) => a.id));
  const missing = data.ideas.flatMap((i) => i.fasApps.filter((id) => !ids.has(id)).map((id) => `${i.id} → ${id}`));
  assert.deepEqual(missing, []);
});

test("validation rejects bad enums, unknown capabilities and non-store links", () => {
  assert.deepEqual(validateIdeas({ ideas: [idea()] }), []);
  assert.ok(validateIdeas({ ideas: [idea(), idea()] }).some((e) => e.includes("duplicate")));
  assert.ok(validateIdeas({ ideas: [idea({ category: "Games" })] }).some((e) => e.includes("category")));
  assert.ok(validateIdeas({ ideas: [idea({ requires: ["teleport"] })] }).some((e) => e.includes("requires")));
  assert.ok(validateIdeas({ ideas: [idea({ anyOf: [["ai-user-key"]] })] }).some((e) => e.includes("anyOf")));
  for (const url of ["https://evil.example/store/apps/details?id=x", "javascript:alert(1)", "https://play.google.com.evil.example/store/apps/details?id=x"]) {
    assert.ok(validateIdeas({ ideas: [idea({ leaders: [{ ...idea().leaders[0], url }] })] }).some((e) => e.includes("url")), url);
  }
  const broken = caps("fas");
  delete broken.capabilities.payments;
  broken.capabilities.teleport = { status: "yes" };
  const errs = validateCapabilities(broken);
  assert.ok(errs.some((e) => e.includes("missing capability payments")));
  assert.ok(errs.some((e) => e.includes("unknown capability teleport")));
});

test("verdicts come from requirements and capabilities", () => {
  assert.equal(verdictFor(idea(), FAS).kind, "ok");
  assert.deepEqual(verdictFor(idea({ requires: ["scheduled-jobs", "push-reminders"] }), FAS), { kind: "blocked", missing: ["scheduled-jobs"], limited: [] });
  assert.deepEqual(verdictFor(idea({ requires: ["user-storage"] }), FAS), { kind: "limited", missing: [], limited: ["user-storage"] });
  assert.equal(verdictFor(idea({ requires: ["native-os"] }), PAS).kind, "native");
  // anyOf: satisfied by any one complete set
  const ai = idea({ anyOf: [["ai-user-key"], ["ai-platform"]] });
  assert.equal(verdictFor(ai, caps("fas", { "ai-platform": "no" })).kind, "ok");
  assert.deepEqual(verdictFor(ai, caps("fas", { "ai-platform": "no", "ai-user-key": "no" })).missing, ["ai-user-key"]);
  // an unrestricted set beats a quota-bound one listed first
  const quota = idea({ anyOf: [["ai-platform"], ["ai-user-key"]] });
  assert.equal(verdictFor(quota, caps("pas", { "ai-platform": "limited" })).kind, "ok");
});

test("statuses: open, covered, upgrade, other, blocked, native, held", () => {
  const h = withApps(here("fas", FAS));
  const o = other(PAS);
  assert.equal(statusOf(idea(), h, o, []), "open");
  assert.equal(statusOf(idea(), h, o, [{ id: "calc" }]), "covered");
  assert.equal(statusOf(idea({ decision: "upgrade-existing" }), h, o, [{ id: "calc" }]), "upgrade");
  assert.equal(statusOf(idea({ decision: "upgrade-existing" }), h, o, []), "open", "nothing live to improve");
  assert.equal(statusOf(idea({ decision: "upgrade-existing" }), withApps(here("pas", PAS)), other(FAS), [{ id: "calc" }]), "covered");
  assert.equal(statusOf(idea({ requires: ["payments"] }), h, o, []), "other");
  assert.equal(statusOf(idea({ requires: ["payments"] }), h, other(caps("pas", { payments: "no" })), []), "blocked");
  assert.equal(statusOf(idea({ requires: ["native-os"] }), h, o, []), "native");
  assert.equal(statusOf(idea({ heldBy: "needs licensed content" }), h, o, []), "held");
});

test("a FAS card blocked by a PAS-only capability names it and links to PAS", () => {
  const data = { ideas: [idea({ requires: ["scheduled-jobs", "payments"] })] };
  const html = renderIdeasPage("{{IDEAS_STATUS_BUTTONS}}|{{IDEAS_CARDS}}", data, here("fas", FAS), other(PAS), escapeHtml);
  assert.ok(html.includes("Needs scheduled jobs and payments"));
  assert.ok(html.includes('href="https://pas.example/ideas#idea-fixture-idea"'));
  assert.ok(!html.includes("Copy build prompt"), "no build prompt for an idea this store cannot build");
  assert.ok(html.includes('data-status="other"'));
});

test("a PAS card marks Pro-only ideas and points free-buildable ones to FAS", () => {
  const data = { ideas: [idea({ id: "paid", requires: ["payments"] }), idea({ id: "free" })] };
  const html = renderIdeasPage("{{IDEAS_CARDS}}", data, here("pas", PAS), other(FAS), escapeHtml);
  const paid = html.slice(html.indexOf('id="idea-paid"'), html.indexOf('id="idea-free"'));
  const free = html.slice(html.indexOf('id="idea-free"'));
  assert.ok(paid.includes("Pro only") && paid.includes('data-exclusive="1"'));
  assert.ok(free.includes("publish it free on") && free.includes('href="https://fas.example/ideas#idea-free"'));
});

test("rendering escapes text, lists limits and links only live catalog apps", () => {
  const data = { researchDate: "2026-10-15", ideas: [idea({ name: XSS, pitch: XSS, requires: ["user-storage"], leaders: [{ name: XSS, store: "apple", chartRank: 3, chart: "US Top Free" }], fasApps: ["calc", "gone"] })] };
  const tpl = "{{IDEAS_COUNT}}|{{IDEAS_OPEN_COUNT}}|{{IDEAS_READY_COUNT}}|{{IDEAS_OTHER_COUNT}}|{{IDEAS_STATUS_BUTTONS}}|{{IDEAS_CATEGORY_BUTTONS}}|{{IDEAS_CARDS}}|{{IDEAS_RESEARCH_DATE}}|{{IDEAS_CAPS_VERIFIED}}";
  const html = renderIdeasPage(tpl, data, here("fas", FAS, [{ id: "calc", name: "Calc" }]), other(PAS), escapeHtml);
  assert.ok(!html.includes(XSS));
  assert.ok(html.includes('href="/apps/calc"'));
  assert.ok(!html.includes("/apps/gone"));
  assert.ok(html.includes("#3 US Top Free"));
  assert.ok(html.includes("Within limits: synced user data") && html.includes("user-storage quota"));
  assert.ok(html.startsWith("1|0|1|0|"), "covered idea counts as buildable, not open");
  assert.ok(!html.includes("{{"));
});

test("text with $ replacement patterns or placeholders renders literally", () => {
  const pitch = "Costs $& or $' or $` and {{IDEAS_COUNT}}";
  const html = renderIdeasPage("{{IDEAS_CARDS}}|{{IDEAS_COUNT}}|{{IDEAS_COUNT}}", { ideas: [idea({ pitch })] }, here("fas", FAS), other(PAS), escapeHtml);
  assert.ok(html.includes(escapeHtml(pitch)));
  assert.ok(html.endsWith("|1|1"));
});

test("the ProAppStore storefront's copy of lib/ideas.cjs is identical", (t) => {
  const pasCopy = resolve(ROOT, "../../../pas/proappstore/scripts/ideas.cjs");
  let theirs;
  try { theirs = readFileSync(pasCopy, "utf8"); } catch { return t.skip("proappstore checkout not next to this repo"); }
  assert.equal(theirs, readFileSync(join(ROOT, "lib/ideas.cjs"), "utf8"), "copy sites/storefront/lib/ideas.cjs to proappstore scripts/ideas.cjs");
});

test("build writes /ideas, the shared data files, the script and a sitemap entry", () => {
  const tmp = mkdtempSync(join(tmpdir(), "fas-ideas-"));
  const run = (env) => execFileSync(process.execPath, ["build.js"], { cwd: ROOT, env: { ...process.env, FAS_OFFLINE: "1", ...env }, stdio: ["ignore", "ignore", "pipe"], timeout: 120_000 });
  try {
    const dist = join(tmp, "dist");
    const ideasPath = join(tmp, "ideas.json");
    writeFileSync(ideasPath, JSON.stringify({ researchDate: "2026-10-15", ideas: [idea(), idea({ id: "second", name: XSS, requires: ["native-os"] })] }));
    run({ FAS_DIST: dist, FAS_IDEAS_PATH: ideasPath });
    const html = readFileSync(join(dist, "ideas.html"), "utf8");
    assert.ok(html.includes('id="idea-fixture-idea"') && html.includes('id="idea-second"'));
    assert.ok(!html.includes(XSS));
    assert.ok(!/{{[A-Z_]+}}/.test(html), "no unsubstituted placeholders");
    assert.match(html, /<script src="\/ideas\.js\?v=[^"]+" integrity="sha256-/);
    readFileSync(join(dist, "ideas.js"));
    assert.equal(JSON.parse(readFileSync(join(dist, "ideas.json"), "utf8")).ideas.length, 2);
    assert.equal(JSON.parse(readFileSync(join(dist, "capabilities.json"), "utf8")).platform, "fas");
    assert.ok(readFileSync(join(dist, "sitemap.xml"), "utf8").includes("https://freeappstore.online/ideas</loc>"));

    writeFileSync(ideasPath, JSON.stringify({ ideas: [idea({ leaders: [{ name: "x", store: "play", url: "https://evil.example/" }] })] }));
    assert.throws(() => run({ FAS_DIST: dist, FAS_IDEAS_PATH: ideasPath }), "a non-store link must fail the build");
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});
