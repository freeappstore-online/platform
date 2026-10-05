#!/bin/bash
# Migrate Direct Upload CF Pages projects to GitHub-connected.
# Deletes the project and recreates it with GitHub source.
# Custom domains and DNS records must be re-added after migration.
#
# Usage: ./migrate-to-github.sh <cf-project> <org> <repo>
# Example: ./migrate-to-github.sh freetimerapp freeappstore-online timer

set -e

CF_PROJECT="$1"
ORG="$2"
REPO="$3"

if [ -z "$CF_PROJECT" ] || [ -z "$ORG" ] || [ -z "$REPO" ]; then
  echo "Usage: ./migrate-to-github.sh <cf-project> <org> <repo>"
  echo "Example: ./migrate-to-github.sh freetimerapp freeappstore-online timer"
  exit 1
fi

ACCT="c1089bfcc43c1c6c2aa89e584e86f0bc"

wrangler whoami > /dev/null 2>&1
CF_TOKEN=$(grep oauth_token ~/Library/Preferences/.wrangler/config/default.toml | cut -d'"' -f2)

# Check current state
echo -n "Checking $CF_PROJECT... "
CURRENT=$(curl -s "https://api.cloudflare.com/client/v4/accounts/$ACCT/pages/projects/$CF_PROJECT" \
  -H "Authorization: Bearer $CF_TOKEN" | python3 -c "
import sys,json
r = json.load(sys.stdin)
if not r['success']: print('NOT_FOUND'); sys.exit()
src = r['result'].get('source')
if src: print(f'GITHUB:{src[\"config\"][\"owner\"]}/{src[\"config\"][\"repo_name\"]}')
else: print('DIRECT_UPLOAD')
")
echo "$CURRENT"

if [[ "$CURRENT" == GITHUB:* ]]; then
  echo "Already GitHub-connected. No migration needed."
  exit 0
fi

if [ "$CURRENT" = "NOT_FOUND" ]; then
  echo "Project not found. Creating fresh."
fi

# Save existing custom domains
echo -n "Saving domains... "
DOMAINS=$(curl -s "https://api.cloudflare.com/client/v4/accounts/$ACCT/pages/projects/$CF_PROJECT/domains" \
  -H "Authorization: Bearer $CF_TOKEN" | python3 -c "
import sys,json
r = json.load(sys.stdin)
if r['success']:
    domains = [d['name'] for d in r['result'] if not d['name'].endswith('.pages.dev')]
    print(' '.join(domains))
else:
    print('')
")
echo "${DOMAINS:-none}"

# Delete old project
if [ "$CURRENT" != "NOT_FOUND" ]; then
  echo -n "Deleting old project... "
  curl -s -X DELETE "https://api.cloudflare.com/client/v4/accounts/$ACCT/pages/projects/$CF_PROJECT" \
    -H "Authorization: Bearer $CF_TOKEN" | python3 -c "import sys,json; d=json.load(sys.stdin); print('OK' if d['success'] else d['errors'])"
  sleep 2
fi

# Create with GitHub source
echo -n "Creating with GitHub source ($ORG/$REPO)... "
curl -s -X POST "https://api.cloudflare.com/client/v4/accounts/$ACCT/pages/projects" \
  -H "Authorization: Bearer $CF_TOKEN" -H "Content-Type: application/json" \
  -d "{
    \"name\": \"$CF_PROJECT\",
    \"source\": {
      \"type\": \"github\",
      \"config\": {
        \"owner\": \"$ORG\",
        \"repo_name\": \"$REPO\",
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
  }" | python3 -c "import sys,json; d=json.load(sys.stdin); print('OK' if d['success'] else d['errors'])"

# Re-add custom domains
for domain in $DOMAINS; do
  echo -n "Re-adding domain $domain... "
  curl -s -X POST "https://api.cloudflare.com/client/v4/accounts/$ACCT/pages/projects/$CF_PROJECT/domains" \
    -H "Authorization: Bearer $CF_TOKEN" -H "Content-Type: application/json" \
    -d "{\"name\":\"$domain\"}" | python3 -c "import sys,json; d=json.load(sys.stdin); print('OK' if d['success'] else 'SKIP')"
done

echo ""
echo "Done! $CF_PROJECT is now GitHub-connected to $ORG/$REPO"
echo "Push to main → auto-build → auto-deploy. No secrets needed."
