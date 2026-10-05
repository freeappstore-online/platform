#!/bin/bash
# Publish an app to FreeAppStore.
# This is the ONLY correct way to publish. Do not use wrangler CLI directly.
#
# Usage: ./publish.sh <app-id> "<name>" "<category>" "<icon>" "<icon-bg>" "<description>" [type]
# Example: ./publish.sh calendar "Calendar" "utilities" "&#128197;" "#f0fdf4" "Simple calendar" standalone
#
# Prerequisites:
# - App repo exists at freeappstore-online/<app-id> on GitHub
# - wrangler CLI is authenticated (run `wrangler whoami`)
# - CLOUDFLARE_API_KEY env var set (Global API Key, for DNS only)
#
# What this script does:
# 1. Verifies the GitHub repo exists
# 2. Creates CF Pages project WITH GitHub integration (not Direct Upload)
# 3. Adds custom domain to CF Pages
# 4. Adds DNS CNAME record
# 5. Adds app to store registry
# 6. Rebuilds and pushes store site (auto-deploys via GitHub Actions)

set -e

APP_ID="$1"
APP_NAME="$2"
CATEGORY="$3"
ICON="$4"
ICON_BG="$5"
DESC="$6"
APP_TYPE="${7:-standalone}"

if [ -z "$APP_ID" ] || [ -z "$APP_NAME" ] || [ -z "$CATEGORY" ]; then
  echo "Usage: ./publish.sh <id> <name> <category> <icon> <icon-bg> <description> [type]"
  echo ""
  echo "Example:"
  echo "  ./publish.sh calendar Calendar utilities '&#128197;' '#f0fdf4' 'Simple calendar' standalone"
  echo ""
  echo "Prerequisites:"
  echo "  - Repo freeappstore-online/<id> must exist on GitHub"
  echo "  - wrangler CLI authenticated (wrangler whoami)"
  echo "  - CLOUDFLARE_API_KEY env var set (for DNS)"
  exit 1
fi

ACCT="c1089bfcc43c1c6c2aa89e584e86f0bc"
ZONE="ebe8a9b64cb958520b8c32114f7f06ec"
EMAIL="serge.the.dev@gmail.com"
CF_PROJECT="free${APP_ID}app"
STORE_DIR="${STORE_DIR:-$HOME/dev/fas/infra/freeappstore}"

echo "═══════════════════════════════════════"
echo "  Publishing: $APP_NAME ($APP_ID)"
echo "  Project:    $CF_PROJECT"
echo "  Domain:     $APP_ID.freeappstore.online"
echo "═══════════════════════════════════════"
echo ""

# 1. Verify repo exists
echo -n "[1/7] Verify repo freeappstore-online/$APP_ID... "
gh api "repos/freeappstore-online/$APP_ID" --jq '.full_name' 2>/dev/null || { echo "FAILED — repo not found"; exit 1; }

# 2. Get wrangler OAuth token (auto-refreshes)
wrangler whoami > /dev/null 2>&1
CF_TOKEN=$(grep oauth_token ~/Library/Preferences/.wrangler/config/default.toml | cut -d'"' -f2)

# 3. Create CF Pages project WITH GitHub source (not Direct Upload!)
echo -n "[2/7] CF Pages project ($CF_PROJECT)... "
RESULT=$(curl -s -X POST "https://api.cloudflare.com/client/v4/accounts/$ACCT/pages/projects" \
  -H "Authorization: Bearer $CF_TOKEN" -H "Content-Type: application/json" \
  -d "{
    \"name\": \"$CF_PROJECT\",
    \"source\": {
      \"type\": \"github\",
      \"config\": {
        \"owner\": \"freeappstore-online\",
        \"repo_name\": \"$APP_ID\",
        \"production_branch\": \"main\",
        \"deployments_enabled\": true,
        \"production_deployments_enabled\": true
      }
    },
    \"build_config\": {
      \"build_command\": \"npx pnpm@10 install && npx pnpm@10 build\",
      \"destination_dir\": \"web/dist\"
    },
    \"deployment_configs\": {
      \"production\": {
        \"env_vars\": { \"NODE_VERSION\": { \"value\": \"22\" } }
      }
    }
  }")
echo "$RESULT" | python3 -c "import sys,json; d=json.load(sys.stdin); print('OK' if d['success'] else f'SKIP ({d[\"errors\"][0][\"message\"]})')"

# 4. Add custom domain
echo -n "[3/7] Custom domain ($APP_ID.freeappstore.online)... "
curl -s -X POST "https://api.cloudflare.com/client/v4/accounts/$ACCT/pages/projects/$CF_PROJECT/domains" \
  -H "Authorization: Bearer $CF_TOKEN" -H "Content-Type: application/json" \
  -d "{\"name\":\"$APP_ID.freeappstore.online\"}" | python3 -c "import sys,json; d=json.load(sys.stdin); print('OK' if d['success'] else 'SKIP')"

# 5. DNS CNAME
echo -n "[4/7] DNS CNAME... "
if [ -n "$CLOUDFLARE_API_KEY" ]; then
  curl -s -X POST "https://api.cloudflare.com/client/v4/zones/$ZONE/dns_records" \
    -H "X-Auth-Email: $EMAIL" -H "X-Auth-Key: $CLOUDFLARE_API_KEY" -H "Content-Type: application/json" \
    -d "{\"type\":\"CNAME\",\"name\":\"$APP_ID\",\"content\":\"$CF_PROJECT.pages.dev\",\"proxied\":true}" | python3 -c "import sys,json; d=json.load(sys.stdin); print('OK' if d['success'] else 'SKIP (may already exist)')"
else
  echo "SKIP (set CLOUDFLARE_API_KEY env var)"
fi

# 6. Update registry
echo -n "[5/7] Update registry... "
if [ -f "$STORE_DIR/registry.json" ]; then
  python3 -c "
import json, sys
with open('$STORE_DIR/registry.json') as f:
    reg = json.load(f)
if any(a['id'] == '$APP_ID' for a in reg['apps']):
    print('SKIP (already listed)')
else:
    reg['apps'].append({
        'id': '$APP_ID', 'name': '$APP_NAME', 'category': '$CATEGORY',
        'icon': '$ICON', 'iconBg': '$ICON_BG', 'description': '$DESC',
        'appUrl': 'https://$APP_ID.freeappstore.online',
        'repo': 'freeappstore-online/$APP_ID', 'cfProject': '$CF_PROJECT',
        'type': '$APP_TYPE', 'developer': 'FreeAppStore'
    })
    with open('$STORE_DIR/registry.json', 'w') as f:
        json.dump(reg, f, indent=2)
    print('OK')
"
else
  echo "SKIP (registry.json not found at $STORE_DIR)"
fi

# 7. Rebuild and push store (auto-deploys via GitHub Actions)
echo -n "[6/7] Rebuild store site... "
cd "$STORE_DIR" && node build.js > /dev/null 2>&1 && echo "OK" || echo "FAILED"

echo -n "[7/7] Push (triggers auto-deploy)... "
cd "$STORE_DIR" && git add -A && git commit -m "Add $APP_NAME to app directory" > /dev/null 2>&1 && git push > /dev/null 2>&1 && echo "OK" || echo "SKIP (no changes)"

echo ""
echo "═══════════════════════════════════════"
echo "  Done! $APP_NAME published."
echo ""
echo "  App:    https://$APP_ID.freeappstore.online"
echo "  Store:  https://freeappstore.online/apps/$APP_ID.html"
echo "  Repo:   https://github.com/freeappstore-online/$APP_ID"
echo ""
echo "  Push to main → auto-deploys. No manual steps needed."
echo "═══════════════════════════════════════"
