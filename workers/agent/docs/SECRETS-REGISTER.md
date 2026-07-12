# FreeAppStore — Secrets Register

Last updated: 2026-07-12

## Master Credentials

All infra secrets are managed in the private SOPS repo
`serge-ivo/secrets` (`~/dev/secrets`). Doppler is retired. The canonical map is
`~/dev/secrets/inventory.yaml`; encrypted values live in
`~/dev/secrets/secrets.enc.yaml`.

| # | Name | What it is | Where it lives | Used by |
|---|------|-----------|----------------|---------|
| 1 | **GITHUB_TOKEN** | Fine-grained PAT for `freeappstore-online` org | SOPS + wrangler secret | Agent/Admin |
| 2 | **SESSION_SIGNING_KEY** | HMAC key for session tokens | SOPS + wrangler secret | API (auth) |
| 3 | **APP_SECRET_KEK** | AES-256 key for app secrets encryption | SOPS + wrangler secret | API (secrets vault) |
| 4 | **GITHUB_CLIENT_SECRET** | OAuth App secret | SOPS + wrangler secret | API (GitHub OAuth) |
| 5 | **RESEND_API_KEY** | Transactional email | SOPS + wrangler secret | API (email) |
| 6 | **CLOUDFLARE_API_TOKEN** | R2/D1 access for GitHub Actions | SOPS + GitHub org secret | GitHub Actions (deploy) |

## Where each secret is deployed

```
                        Agent   API   Admin   Host
GITHUB_TOKEN              ✓
SESSION_SIGNING_KEY               ✓
APP_SECRET_KEK                    ✓
GITHUB_CLIENT_SECRET              ✓
RESEND_API_KEY                    ✓
CLOUDFLARE_API_TOKEN    (GH Actions — org-level, all repos)
```

Notes:
- Agent only needs GITHUB_TOKEN (creates repo + pushes; GH Actions does R2 deploy)
- CF_API_TOKEN is **no longer used** by the agent (legacy from CF Pages era)
- No auto-sync. When a value changes, update every consumer listed in
  `~/dev/secrets/inventory.yaml`.
- Worker runtime secrets are synced with `scripts/sync-worker-secrets.sh`.

## How to set/rotate secrets

```bash
# Edit encrypted values in the private secrets repo.
cd ~/dev/secrets
sops secrets.enc.yaml

# Push worker secrets from the platform repo. Values are piped, never printed.
cd ~/dev/stores/fas/platform
SECRETS_PROJECT=fas bash scripts/sync-worker-secrets.sh packages/backend
```

## Verify

```bash
curl -s https://agent.freeappstore.online/health | jq .ok
curl -s https://api.freeappstore.online/health | jq .ok
```
