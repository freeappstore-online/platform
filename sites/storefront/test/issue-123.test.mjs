/** CSP regression coverage for issue #123: stylesheet links must not rely on inline events. */

import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const ROOT = resolve(dirname(__filename), "..");
const TEMPLATES = join(ROOT, "templates");

function templateFiles(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const file = join(dir, entry.name);
    if (entry.isDirectory()) return templateFiles(file);
    return entry.isFile() && entry.name.endsWith(".html") ? [file] : [];
  });
}

test("issue #123: storefront templates contain no inline event-handler attributes", () => {
  const inlineEventAttribute = /\s+on[a-z][a-z0-9:_-]*\s*=/i;
  const templates = templateFiles(TEMPLATES);

  assert.ok(templates.length > 0, "test must cover storefront templates");
  for (const file of templates) {
    const template = readFileSync(file, "utf8");
    assert.doesNotMatch(
      template,
      inlineEventAttribute,
      `${relative(ROOT, file)} must not use CSP-blocked inline event attributes`,
    );
  }
});

test("issue #123: homepage loads the Manrope and Fraunces stylesheet directly with font swapping", () => {
  const homepage = readFileSync(join(TEMPLATES, "index.html"), "utf8");
  const fontLink = homepage.match(/<link\b(?=[^>]*\brel="stylesheet")[^>]*fonts\.googleapis\.com[^>]*>/i)?.[0] || "";

  assert.match(fontLink, /rel="stylesheet"/i);
  assert.match(fontLink, /family=Fraunces/i);
  assert.match(fontLink, /family=Manrope/i);
  assert.match(fontLink, /display=swap/i);
  assert.doesNotMatch(fontLink, /\bmedia\s*=\s*["']print["']/i);
  assert.doesNotMatch(fontLink, /\son[a-z][a-z0-9:_-]*\s*=/i);
});
