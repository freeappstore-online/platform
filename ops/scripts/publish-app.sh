#!/bin/bash
# Publish a new app to FreeAppStore.
# Usage: ./publish-app.sh <app-id>
# Example: ./publish-app.sh calendar
#
# Prerequisites:
# - App repo exists at freeappstore-online/<app-id>
# - wrangler is authenticated (run `wrangler whoami` first)
# - Required env vars (admin only):
#     CF_ACCOUNT_ID         CF account ID (find in dashboard URL)
#     CF_ZONE_ID            DNS zone ID for freeappstore.online
#     CF_ADMIN_EMAIL        Admin email tied to the CF account
#     CLOUDFLARE_API_KEY    CF Global API Key (for DNS writes)

set -e

APP_ID="$1"
if [ -z "$APP_ID" ]; then
  echo "Usage: ./publish-app.sh <app-id>"
  echo "Example: ./publish-app.sh calendar"
  exit 1
fi

ACCT="${CF_ACCOUNT_ID:?set CF_ACCOUNT_ID env var}"
ZONE="${CF_ZONE_ID:?set CF_ZONE_ID env var}"
EMAIL="${CF_ADMIN_EMAIL:?set CF_ADMIN_EMAIL env var}"
CF_PROJECT="free${APP_ID}app"

# Refresh wrangler token
wrangler whoami > /dev/null 2>&1
CF_TOKEN=$(grep oauth_token ~/Library/Preferences/.wrangler/config/default.toml | cut -d'"' -f2)

echo "Publishing ${APP_ID} to FreeAppStore..."
echo ""

# 1. Verify repo exists
echo -n "1. Verify repo... "
gh api repos/freeappstore-online/${APP_ID} --jq '.full_name' 2>/dev/null || {
  echo "FAILED: repo freeappstore-online/${APP_ID} not found"
  exit 1
}

# 2. Create CF Pages project
echo -n "2. Create CF Pages project (${CF_PROJECT})... "
RESULT=$(curl -s -X POST "https://api.cloudflare.com/client/v4/accounts/${ACCT}/pages/projects" \
  -H "Authorization: Bearer ${CF_TOKEN}" \
  -H "Content-Type: application/json" \
  --data "{
    \"name\": \"${CF_PROJECT}\",
    \"source\": {\"type\": \"github\", \"config\": {\"owner\": \"freeappstore-online\", \"repo_name\": \"${APP_ID}\", \"production_branch\": \"main\", \"deployments_enabled\": true}},
    \"build_config\": {\"build_command\": \"pnpm install && pnpm build\", \"destination_dir\": \"web/dist\"},
    \"deployment_configs\": {\"production\": {\"env_vars\": {\"NODE_VERSION\": {\"value\": \"22\"}}}}
  }")
echo "$RESULT" | python3 -c "import sys,json; d=json.load(sys.stdin); print('OK' if d['success'] else f'SKIP ({d[\"errors\"][0][\"message\"]})')"

# 3. Add custom domain
echo -n "3. Add custom domain (${APP_ID}.freeappstore.online)... "
RESULT=$(curl -s -X POST "https://api.cloudflare.com/client/v4/accounts/${ACCT}/pages/projects/${CF_PROJECT}/domains" \
  -H "Authorization: Bearer ${CF_TOKEN}" \
  -H "Content-Type: application/json" \
  --data "{\"name\":\"${APP_ID}.freeappstore.online\"}")
echo "$RESULT" | python3 -c "import sys,json; d=json.load(sys.stdin); print('OK' if d['success'] else f'SKIP ({d[\"errors\"][0][\"message\"]})')"

# 4. Add DNS CNAME
echo -n "4. Add DNS CNAME... "
if [ -z "$CLOUDFLARE_API_KEY" ]; then
  echo "SKIP (set CLOUDFLARE_API_KEY env var)"
else
  RESULT=$(curl -s -X POST "https://api.cloudflare.com/client/v4/zones/${ZONE}/dns_records" \
    -H "X-Auth-Email: ${EMAIL}" \
    -H "X-Auth-Key: ${CLOUDFLARE_API_KEY}" \
    -H "Content-Type: application/json" \
    --data "{\"type\":\"CNAME\",\"name\":\"${APP_ID}\",\"content\":\"${CF_PROJECT}.pages.dev\",\"proxied\":true}")
  echo "$RESULT" | python3 -c "import sys,json; d=json.load(sys.stdin); print('OK' if d['success'] else f'SKIP ({d[\"errors\"][0][\"message\"]})')"
fi

# 5. Trigger first deploy
echo -n "5. Trigger deploy... "
RESULT=$(curl -s -X POST "https://api.cloudflare.com/client/v4/accounts/${ACCT}/pages/projects/${CF_PROJECT}/deployments" \
  -H "Authorization: Bearer ${CF_TOKEN}" \
  -H "Content-Type: application/json" \
  --data '{}')
echo "$RESULT" | python3 -c "import sys,json; d=json.load(sys.stdin); print('OK' if d['success'] else 'SKIP')" 2>/dev/null || echo "OK (will deploy on next push)"

echo ""
echo "Done! Next steps:"
echo "  1. Add app to registry.json"
echo "  2. Create apps/${APP_ID}.html detail page"
echo "  3. Add card to index.html"
echo "  4. Update sitemap.xml"
echo "  5. Push freeappstore landing site"
echo ""
echo "App will be live at: https://${APP_ID}.freeappstore.online"
