#!/bin/bash
# Run platform compliance checks locally before pushing.
# Usage: ./check-compliance.sh (from app root directory)

set -e
RED='\033[0;31m'
GREEN='\033[0;32m'
NC='\033[0m'
PASS=0
FAIL=0

check() {
  if eval "$2" > /dev/null 2>&1; then
    echo -e "  ${GREEN}✓${NC} $1"
    PASS=$((PASS + 1))
  else
    echo -e "  ${RED}✗${NC} $1"
    FAIL=$((FAIL + 1))
  fi
}

echo "Platform Compliance Check"
echo "========================="
echo ""

check "MIT License" "grep -qi MIT LICENSE"
check "No .env.production" "test ! -f .env.production && test ! -f web/.env.production"
check "pnpm workspace" "grep -q pnpm package.json && test -f pnpm-workspace.yaml"

FORBIDDEN="google-analytics|gtag|amplitude|mixpanel|segment|hotjar|plausible|posthog"
check "No tracking" "! grep -rE '$FORBIDDEN' web/src/ 2>/dev/null | grep -q ."

CSS_FILE=$(find web/src -name "index.css" 2>/dev/null | head -1)
check "Brand font: Manrope" "grep -qi manrope '$CSS_FILE'"
check "Brand font: Fraunces" "grep -qi fraunces '$CSS_FILE'"
check "CSS var: --paper" "grep -q '\-\-paper' '$CSS_FILE'"
check "CSS var: --ink" "grep -q '\-\-ink' '$CSS_FILE'"
check "CSS var: --accent" "grep -q '\-\-accent' '$CSS_FILE'"

check "HTML lang attribute" "grep -q 'lang=' web/index.html"
check "HTML viewport meta" "grep -q viewport web/index.html"
check "HTML title" "grep -q '<title>' web/index.html"
check "PWA meta tag" "grep -qi 'apple-mobile-web-app-capable\|mobile-web-app-capable' web/index.html"
check "PWA manifest" "find web/public -name manifest.json 2>/dev/null | grep -q ."
check "FreeAppStore link" "grep -r freeappstore.online web/src/ 2>/dev/null | grep -q ."
check "Dark mode" "grep -rE 'prefers-color-scheme|data-theme|color-scheme' web/src/ 2>/dev/null | grep -q ."

echo ""
echo "Build check..."
if pnpm build > /dev/null 2>&1; then
  echo -e "  ${GREEN}✓${NC} Build passes"
  PASS=$((PASS + 1))

  # Initial-load JS ≤ 300KB gzip; lazy wasm/workers/dynamic chunks ≤ 25MB.
  # Same rule as `fas check` bundle-size. A missing index.html counts every
  # JS asset as initial, so a huge bundle cannot hide.
  if node --input-type=module <<'EOF'
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';

const INITIAL_MAX = 300 * 1024;
const LAZY_MAX = 25 * 1024 * 1024;
const dir = 'web/dist/assets';
if (!existsSync(dir)) process.exit(0);
const names = readdirSync(dir).filter((n) => {
  try { return statSync(join(dir, n)).isFile(); } catch { return false; }
});
const isJs = (n) => /\.(?:m|c)?js$/i.test(n);
const isLazy = (n) =>
  !/\.map$/i.test(n) &&
  (isJs(n) || /\.(?:wasm|data|bin|onnx|tflite|traineddata|gz|zst)$/i.test(n));
const attr = (tag, name) => {
  const m = new RegExp(`(?:^|\\s)${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)')`, 'i').exec(tag);
  return m?.[1] ?? m?.[2];
};
const initial = new Set();
const htmlPath = 'web/dist/index.html';
if (existsSync(htmlPath)) {
  const html = readFileSync(htmlPath, 'utf8');
  const refs = [];
  for (const m of html.matchAll(/<script\b[^>]*>/gi)) {
    const src = attr(m[0], 'src');
    if (src) refs.push(src);
  }
  for (const m of html.matchAll(/<link\b[^>]*>/gi)) {
    if ((attr(m[0], 'rel') || '').toLowerCase() === 'modulepreload') {
      const href = attr(m[0], 'href');
      if (href) refs.push(href);
    }
  }
  for (const ref of refs) {
    const path = ref.split(/[?#]/, 1)[0].replace(/^\.\//, '');
    const mm = /(?:^|\/)assets\/(.+\.m?js)$/i.exec(path);
    if (mm) initial.add(mm[1]);
  }
  const seen = new Set();
  const queue = [...initial];
  const importRe =
    /(?:^|[\n;])\s*(?:import|export)\s*(?:type\s+)?(?:[^\n'"()]*?from\s*)?["'](\.[^"']+)["']/g;
  while (queue.length) {
    const file = queue.pop();
    if (!file || seen.has(file)) continue;
    seen.add(file);
    const full = join(dir, file);
    if (!existsSync(full)) continue;
    const text = readFileSync(full, 'utf8');
    for (const m of text.matchAll(importRe)) {
      const spec = m[1].split(/[?#]/, 1)[0];
      if (!isJs(spec)) continue;
      const fromDir = file.includes('/') ? file.slice(0, file.lastIndexOf('/')) : '';
      const parts = [...(fromDir ? fromDir.split('/') : []), ...spec.split('/')];
      const out = [];
      for (const p of parts) {
        if (p === '.' || p === '') continue;
        if (p === '..') out.pop();
        else out.push(p);
      }
      const resolved = out.join('/');
      if (resolved && !seen.has(resolved)) {
        initial.add(resolved);
        queue.push(resolved);
      }
    }
  }
}
let initialJs = [...initial].filter((n) => names.includes(n));
if (initialJs.length === 0) initialJs = names.filter(isJs);
const initialSet = new Set(initialJs);
let failed = false;
for (const name of initialJs) {
  const gz = gzipSync(readFileSync(join(dir, name))).length;
  if (gz > INITIAL_MAX) {
    console.error(`${name}: ${(gz / 1024).toFixed(1)} KB gzipped (limit 300 KB initial load)`);
    failed = true;
  } else {
    console.log(`${name}: ${(gz / 1024).toFixed(1)} KB gzipped (initial load)`);
  }
}
for (const name of names) {
  if (initialSet.has(name) || !isLazy(name)) continue;
  const size = statSync(join(dir, name)).size;
  if (size > LAZY_MAX) {
    console.error(`${name}: ${(size / (1024 * 1024)).toFixed(1)} MB (limit 25 MB per lazy asset)`);
    failed = true;
  }
}
process.exit(failed ? 1 : 0);
EOF
  then
    echo -e "  ${GREEN}✓${NC} Bundle size"
    PASS=$((PASS + 1))
  else
    echo -e "  ${RED}✗${NC} Bundle size (initial load 300KB gzip, lazy assets 25MB)"
    FAIL=$((FAIL + 1))
  fi
else
  echo -e "  ${RED}✗${NC} Build failed"
  FAIL=$((FAIL + 1))
fi

echo ""
echo "========================="
echo -e "Results: ${GREEN}${PASS} passed${NC}, ${RED}${FAIL} failed${NC}"

if [ "$FAIL" -gt 0 ]; then
  echo -e "${RED}Fix the failures above before pushing.${NC}"
  exit 1
else
  echo -e "${GREEN}All checks passed. Ready to push.${NC}"
fi
