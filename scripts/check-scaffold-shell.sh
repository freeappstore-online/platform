#!/usr/bin/env bash
# Checks that a freshly scaffolded FreeAppStore app starts on the SDK Shell
# with real navigation (#93). Run by scaffold-smoke.yml on every `fas init`
# template; runnable locally against any scaffold:
#
#   bash scripts/check-scaffold-shell.sh <app-dir> <standalone|connected>
set -uo pipefail

dir="${1:?usage: check-scaffold-shell.sh <app-dir> <standalone|connected>}"
template="${2:?usage: check-scaffold-shell.sh <app-dir> <standalone|connected>}"
app="$dir/web/src/App.tsx"
fails=0
fail() { echo "FAIL: $1"; fails=$((fails + 1)); }

[ -f "$app" ] || { echo "FAIL: $app not found"; exit 1; }

# The SDK Shell is the root, with a nav item per screen.
grep -Eq "import \{[^}]*\bShell\b[^}]*\} from '@freeappstore/sdk/ui'" "$app" ||
  fail "App.tsx does not import Shell from @freeappstore/sdk/ui"
grep -Eq "<Shell [^>]*\bnav=\{" "$app" || fail "App.tsx does not render <Shell … nav={…}>"
grep -Eq "\{ label: '[^']+', href: '/[^']*'" "$app" || fail "App.tsx declares no nav items"

# No hand-rolled shell, and no Firebase (the platform SDK is the backend).
[ ! -e "$dir/web/src/components/Shell.tsx" ] || fail "hand-rolled web/src/components/Shell.tsx is present"
if grep -rqi "firebase" "$dir/web/src" "$dir/web/package.json" "$dir/package.json" 2>/dev/null; then
  fail "Firebase is referenced"
fi

# An SDK with the navbar and resilience layer.
range=$(node -e "const p=require(process.argv[1]);process.stdout.write((p.dependencies||{})['@freeappstore/sdk']||'')" "$(cd "$dir" && pwd)/web/package.json")
if [[ "$range" =~ ^\^?0\.14\.([0-9]+)$ ]]; then
  [ "${BASH_REMATCH[1]}" -ge 30 ] || fail "@freeappstore/sdk $range is below 0.14.30"
elif [[ ! "$range" =~ ^\^?(0\.(1[5-9]|[2-9][0-9])|[1-9][0-9]*)\. ]]; then
  fail "@freeappstore/sdk range '$range' is missing or below 0.14.30"
fi

# Sign-in gate: connected apps work on the user's data, standalone apps don't sign in.
case "$template" in
  connected) grep -Eq "<Shell [^>]*\brequireAuth\b" "$app" || fail "connected template's Shell lacks requireAuth" ;;
  standalone) ! grep -Eq "<Shell [^>]*\brequireAuth\b" "$app" || fail "standalone template's Shell requires sign-in" ;;
  *) echo "unknown template '$template' (standalone|connected)"; exit 2 ;;
esac

if [ "$fails" -gt 0 ]; then
  echo "$fails problem(s): the $template scaffold must start on the SDK Shell with nav (#93)."
  exit 1
fi
echo "OK: $template scaffold renders the SDK Shell with nav (@freeappstore/sdk $range)"
