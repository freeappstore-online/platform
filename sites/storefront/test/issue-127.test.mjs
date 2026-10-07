/** CSP regression coverage for issue #127: quality audit fixture. */

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const ROOT = resolve(dirname(__filename), "..");

function buildStorefront() {
  const tmp = mkdtempSync(join(tmpdir(), "fas-csp-127-"));
  const dist = join(tmp, "dist");
  execFileSync(process.execPath, ["build.js"], {
    cwd: ROOT,
    env: { ...process.env, FAS_DIST: dist },
    stdio: ["ignore", "ignore", "ignore"],
    timeout: 60_000,
  });
  return { tmp, dist };
}

function executableInlineScripts(html) {
  return [...html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)].filter(([, attrs]) => {
    if (/\ssrc\s*=/i.test(attrs)) return false;
    const type = attrs.match(/\stype\s*=\s*["']([^"']+)["']/i)?.[1].trim().toLowerCase();
    return !type || type === "module" || type === "text/javascript";
  });
}

test("issue #127: fixture is CSP-clean and the esm.sh exception is route-scoped", () => {
  const { tmp, dist } = buildStorefront();
  try {
    const headers = readFileSync(join(dist, "_headers"), "utf8");
    const globalCsp = headers.match(/^  Content-Security-Policy: (.+)$/m)?.[1] || "";
    const fixtureCsp = headers.match(/^\/audit-fixture\/\*\n  Content-Security-Policy: (.+)$/m)?.[1] || "";
    assert.match(globalCsp, /script-src 'self'/);
    assert.doesNotMatch(globalCsp, /https:\/\/esm\.sh|unsafe-inline/);
    assert.match(fixtureCsp, /script-src 'self'[^;]*https:\/\/esm\.sh/);
    assert.match(fixtureCsp, /frame-ancestors 'self'/, "the same-origin quality dashboard must be able to frame the fixture");
    assert.doesNotMatch(fixtureCsp, /unsafe-inline/);

    const fixture = readFileSync(join(dist, "audit-fixture", "index.html"), "utf8");
    assert.match(fixture, /<link\b[^>]+href="\.\/fixture\.css"/i);
    assert.match(fixture, /<script\b[^>]+type="module"[^>]+src="\.\/fixture\.js"/i);
    assert.equal(executableInlineScripts(fixture).length, 0, "fixture must not ship inline executable JS");
    assert.doesNotMatch(fixture, /<style\b|\sstyle\s*=/i, "fixture must not ship inline CSS");
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("issue #127: every documented scenario reports except the intentional opt-out", () => {
  const fixtureJs = readFileSync(join(ROOT, "audit-fixture", "fixture.js"), "utf8");
  const fixtureCss = readFileSync(join(ROOT, "audit-fixture", "fixture.css"), "utf8");
  const scenarios = [
    "fits", "scroll-x", "scroll-y", "clip-inner", "clip-inner-y", "vh-bug",
    "gap-mid", "landscape-only-bad", "no-reporter", "large-scrollwidth-fp",
  ];

  for (const scenario of scenarios) {
    assert.match(fixtureJs, new RegExp(`['"]${scenario}['"]|\\b${scenario}:`), `missing ${scenario} scenario`);
  }
  assert.match(fixtureJs, /import\('https:\/\/esm\.sh\/@freeappstore\/quality@0\.1\.0'\)/);
  assert.match(fixtureJs, /scenario !== 'no-reporter'/, "only the documented opt-out may skip the reporter");
  assert.match(fixtureJs, /initQualityReporter\(\)/, "cooperating scenarios must initialize the reporter");
  assert.doesNotMatch(fixtureJs, /<[^>]+\sstyle=/i, "dynamic fixture markup must use CSS classes");
  assert.match(fixtureCss, /\.fixture-padded\s*\{\s*padding:/, "former dynamic padding must be external CSS");
  assert.match(fixtureCss, /\.index-foot\s*\{/, "former dynamic index presentation must be external CSS");
});
