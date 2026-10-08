/** Accessibility regression coverage for issue #126: the custom 404 page. */

import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const DIST = join(ROOT, "dist");

function findHtmlFiles(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const file = join(directory, entry.name);
    if (entry.isDirectory()) return findHtmlFiles(file);
    return entry.isFile() && entry.name.endsWith(".html") ? [file] : [];
  });
}

test("issue #126: every built page with a header has a skip link and main target", () => {
  const pages = findHtmlFiles(DIST);
  assert.ok(pages.includes(join(DIST, "404.html")), "dist/404.html must be checked");

  for (const page of pages) {
    const html = readFileSync(page, "utf8");
    const headerIndex = html.search(/<header\b/i);
    if (headerIndex === -1) continue;

    const name = relative(DIST, page);
    const beforeHeader = html.slice(0, headerIndex);
    assert.match(
      beforeHeader,
      /<a\b(?=[^>]*\bclass=["'][^"']*\bskip-link\b[^"']*["'])(?=[^>]*\bhref=["']#main-content["'])[^>]*>/i,
      `${name}: a skip link to #main-content must appear before the header`,
    );
    assert.match(
      html,
      /<main\b(?=[^>]*\bid=["']main-content["'])(?=[^>]*\btabindex=["']-1["'])[^>]*>/i,
      `${name}: <main> must provide the focusable #main-content target`,
    );
  }
});
