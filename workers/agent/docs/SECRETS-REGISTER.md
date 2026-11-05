# FreeAppStore — Secrets Register

Last updated: 2026-07-12

## Master Credentials

All infra secrets are SOPS-encrypted in `~/dev/ops` (`serge-ivo/ops`; read its
`AGENTS.md` first). The canonical map is `~/dev/ops/inventory.yaml`; encrypted
values live in `~/dev/ops/secrets.enc.yaml`.

| # | Name | What it is | Where it lives | Used by |
|---|------|-----------|----------------|---------|
| 1 | **GITHUB_TOKEN** | Fine-grained PAT for `freeappstore-online` org | SOPS + wrangler secret | Agent/Admin |
| 2 | **SESSION_SIGNING_KEY** | HMAC key for session tokens | SOPS + wrangler secret | API (auth) |
| 3 | **APP_SECRET_KEK** | AES-256 key for app secrets encryption | SOPS + wrangler secret | API (secrets vault) |
| 4 | **GITHUB_CLIENT_SECRET** | OAuth App secret | SOPS + wrangler secret | API (GitHub OAuth) |
| 5 | **CLOUDFLARE_API_TOKEN** | R2/D1 access for GitHub Actions | SOPS + GitHub org secret | GitHub Actions (deploy) |

## Where each secret is deployed

```
                        Agent   API   Admin   Host
GITHUB_TOKEN              ✓
SESSION_SIGNING_KEY               ✓
APP_SECRET_KEK                    ✓
GITHUB_CLIENT_SECRET              ✓
CLOUDFLARE_API_TOKEN    (GH Actions — org-level, all repos)
```

Notes:
- Agent only needs GITHUB_TOKEN (creates repo + pushes; GH Actions does R2 deploy)
- CF_API_TOKEN is **no longer used** by the agent (legacy from CF Pages era)
- `ops put fas <KEY>` stores a value and pushes it to every consumer listed in
  `~/dev/ops/inventory.yaml` (Workers and GitHub secrets alike).

## How to set/rotate secrets

```bash
# Store/rotate one value: prompts hidden, verifies, pushes to every consumer, commits.
~/dev/ops/bin/ops put fas <KEY>

# Re-place one key on one Worker without changing it.
~/dev/ops/bin/ops push fas <KEY> wrangler freeappstore-api
```

## Verify

```bash
curl -s https://agent.freeappstore.online/health | jq .ok
curl -s https://api.freeappstore.online/health | jq .ok
```
