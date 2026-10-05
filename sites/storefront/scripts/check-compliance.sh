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

  BUNDLE=$(find web/dist -name "*.js" -path "*/assets/*" 2>/dev/null | sort -rn | head -1)
  if [ -n "$BUNDLE" ]; then
    GZIP_SIZE=$(gzip -c "$BUNDLE" | wc -c)
    KB=$((GZIP_SIZE / 1024))
    if [ "$GZIP_SIZE" -lt 307200 ]; then
      echo -e "  ${GREEN}✓${NC} Bundle size: ${KB}KB gzipped"
      PASS=$((PASS + 1))
    else
      echo -e "  ${RED}✗${NC} Bundle too large: ${KB}KB (max 300KB)"
      FAIL=$((FAIL + 1))
    fi
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
