#!/bin/bash
# Full publish: app repo → CF Pages → DNS → registry → deploy
# Usage: ./full-publish.sh <app-id> <name> <category> <icon> <icon-bg> <description> <type>
# Example: ./full-publish.sh slither "Slither" "brain-training" "&#128013;" "#ecfdf5" "Slither.io-style snake game with AI bots" "standalone"
#
# Required env vars (admin only):
#   CF_ACCOUNT_ID         CF account ID (find in dashboard URL)
#   CF_ZONE_ID            DNS zone ID for freeappstore.online
#   CF_ADMIN_EMAIL        Admin email tied to the CF account
#   CLOUDFLARE_API_KEY    CF Global API Key (for DNS writes)

set -e

APP_ID="$1"
APP_NAME="$2"
CATEGORY="$3"
ICON="$4"
ICON_BG="$5"
DESC="$6"
APP_TYPE="${7:-standalone}"

if [ -z "$APP_ID" ] || [ -z "$APP_NAME" ] || [ -z "$CATEGORY" ]; then
  echo "Usage: ./full-publish.sh <id> <name> <category> <icon> <icon-bg> <description> [type]"
  echo "Example: ./full-publish.sh slither Slither brain-training '&#128013;' '#ecfdf5' 'Snake game with AI bots' standalone"
  exit 1
fi

ACCT="${CF_ACCOUNT_ID:?set CF_ACCOUNT_ID env var}"
ZONE="${CF_ZONE_ID:?set CF_ZONE_ID env var}"
EMAIL="${CF_ADMIN_EMAIL:?set CF_ADMIN_EMAIL env var}"
CF_PROJECT="free${APP_ID}app"

echo "Publishing $APP_NAME ($APP_ID) to FreeAppStore..."
echo ""

# 1. Verify repo
echo -n "1. Verify repo... "
gh api repos/freeappstore-online/${APP_ID} --jq '.full_name' 2>/dev/null && echo "" || { echo "FAILED"; exit 1; }

# 2. Refresh token
wrangler whoami > /dev/null 2>&1
CF_TOKEN=$(grep oauth_token ~/Library/Preferences/.wrangler/config/default.toml | cut -d'"' -f2)

# 3. Create CF Pages project
echo -n "2. CF Pages project... "
curl -s -X POST "https://api.cloudflare.com/client/v4/accounts/$ACCT/pages/projects" \
  -H "Authorization: Bearer $CF_TOKEN" -H "Content-Type: application/json" \
  --data "{\"name\":\"$CF_PROJECT\",\"source\":{\"type\":\"github\",\"config\":{\"owner\":\"freeappstore-online\",\"repo_name\":\"$APP_ID\",\"production_branch\":\"main\",\"deployments_enabled\":true}},\"build_config\":{\"build_command\":\"pnpm install && pnpm build\",\"destination_dir\":\"web/dist\"},\"deployment_configs\":{\"production\":{\"env_vars\":{\"NODE_VERSION\":{\"value\":\"22\"}}}}}" | python3 -c "import sys,json; d=json.load(sys.stdin); print('OK' if d['success'] else 'SKIP')"

# 4. Add custom domain
echo -n "3. Custom domain... "
curl -s -X POST "https://api.cloudflare.com/client/v4/accounts/$ACCT/pages/projects/$CF_PROJECT/domains" \
  -H "Authorization: Bearer $CF_TOKEN" -H "Content-Type: application/json" \
  --data "{\"name\":\"$APP_ID.freeappstore.online\"}" | python3 -c "import sys,json; d=json.load(sys.stdin); print('OK' if d['success'] else 'SKIP')"

# 5. DNS CNAME
echo -n "4. DNS record... "
if [ -n "$CLOUDFLARE_API_KEY" ]; then
  curl -s -X POST "https://api.cloudflare.com/client/v4/zones/$ZONE/dns_records" \
    -H "X-Auth-Email: $EMAIL" -H "X-Auth-Key: $CLOUDFLARE_API_KEY" -H "Content-Type: application/json" \
    --data "{\"type\":\"CNAME\",\"name\":\"$APP_ID\",\"content\":\"$CF_PROJECT.pages.dev\",\"proxied\":true}" | python3 -c "import sys,json; d=json.load(sys.stdin); print('OK' if d['success'] else 'SKIP')"
else
  echo "SKIP (set CLOUDFLARE_API_KEY)"
fi

# 6. Trigger first deploy
echo -n "5. Trigger deploy... "
curl -s -X POST "https://api.cloudflare.com/client/v4/accounts/$ACCT/pages/projects/$CF_PROJECT/deployments" \
  -H "Authorization: Bearer $CF_TOKEN" -H "Content-Type: application/json" --data '{}' | python3 -c "import sys,json; d=json.load(sys.stdin); print('OK' if d['success'] else 'SKIP')" 2>/dev/null || echo "OK"

# 7. Add to registry.json
echo -n "6. Update registry... "
STORE_DIR="$HOME/dev/fas/infra/freeappstore"
if [ -f "$STORE_DIR/registry.json" ]; then
  python3 -c "
import json
with open('$STORE_DIR/registry.json') as f:
    reg = json.load(f)
# Check if already exists
if any(a['id'] == '$APP_ID' for a in reg['apps']):
    print('SKIP (already in registry)')
else:
    reg['apps'].append({
        'id': '$APP_ID',
        'name': '$APP_NAME',
        'category': '$CATEGORY',
        'icon': '$ICON',
        'iconBg': '$ICON_BG',
        'description': '$DESC',
        'appUrl': 'https://$APP_ID.freeappstore.online',
        'repo': 'freeappstore-online/$APP_ID',
        'cfProject': '$CF_PROJECT',
        'type': '$APP_TYPE',
        'developer': 'FreeAppStore'
    })
    with open('$STORE_DIR/registry.json', 'w') as f:
        json.dump(reg, f, indent=2)
    print('OK')
"
else
  echo "SKIP (registry.json not found at $STORE_DIR)"
fi

# 8. Rebuild and push landing site
echo -n "7. Rebuild site... "
cd "$STORE_DIR" && node build.js > /dev/null 2>&1 && echo "OK" || echo "FAILED"

echo -n "8. Push site... "
cd "$STORE_DIR" && git add -A && git commit -m "Add $APP_NAME to app directory" > /dev/null 2>&1 && git push > /dev/null 2>&1 && echo "OK" || echo "SKIP (no changes)"

echo ""
echo "Done! $APP_NAME is live at: https://$APP_ID.freeappstore.online"
echo "Detail page: https://freeappstore.online/apps/$APP_ID"
