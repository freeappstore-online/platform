# Architecture

## Stack

- **TypeScript 5.7**, Node 22, pnpm workspaces
- **Backend:** Cloudflare Workers + D1 + Durable Objects + R2
- **Auth:** GitHub, Google, Apple, Email (magic link) OAuth. HMAC-signed sessions, 30-day TTL
- **Realtime:** one Durable Object per room with WebSocket fan-out
- **Apps:** standalone PWA template (Vite + React + Tailwind), deployed to R2 via GitHub Actions, served by host Worker

## Infrastructure

| Resource | Value |
|----------|-------|
| D1 database | `fas` |
| R2 app bucket | `fas-apps` |
| R2 backups | `fas-backups` |
| R2 docs | `fas-kb` |
| Doppler project | `fas` |

## Monorepo layout

```
fas/platform/
├── packages/backend     API worker (Hono, D1, DOs) — api.freeappstore.online
├── packages/cli         @freeappstore/cli
├── packages/sdk         @freeappstore/sdk
├── packages/compliance  Compliance checks
├── packages/quality     VCQA quality scanner
├── packages/kb-host     Docs + KB host worker — docs/kb.freeappstore.online
├── packages/e2e         End-to-end tests
├── workers/admin        Provisioning + moderation — admin.freeappstore.online
├── workers/agent        VibeCode AI app builder
├── workers/host         R2 host worker — *.freeappstore.online
├── workers/mcp          MCP server (12 tools) — mcp.freeappstore.online
├── sites/console        Creator portal — freeappstore.online/app/ (proxied)
├── sites/create         VibeCode + self-service publish — create.freeappstore.online
├── brand/               Brand assets + BRAND.md / SKILLS.md
└── ops/                 Ops docs (DR, infra, submission) + scripts
```

> `workers/*` and `sites/*` are self-contained projects (own `package.json` +
> lockfile) outside the root pnpm workspace globs — folded in from their former
> standalone repos during the 2026-06-30 consolidation.

## Services

| Service | URL | Worker |
|---------|-----|--------|
| Store | freeappstore.online | Static (CF Pages) |
| API | api.freeappstore.online | freeappstore-api |
| Host | *.freeappstore.online | freeappstore-host |
| Admin | admin.freeappstore.online | freeappstore-admin |
| Console | freeappstore.online/app/ | R2 via host (Path B), proxied from apex `/app/*` |
| VibeCode / Publish | create.freeappstore.online | R2 via host (Path B) |
| Docs | docs.freeappstore.online | freeappstore-kb-host |
| KB | kb.freeappstore.online | freeappstore-kb-host |
| MCP | mcp.freeappstore.online | freeappstore-mcp |

## Companion repos

All platform tooling (admin, agent, host, mcp, console, create, brand, ops) lives
**in this monorepo** since the 2026-06-30 consolidation — those former standalone
repos are archived. `publisher` was decommissioned (its provisioning is redundant
with `backend /v1/publish`). Only these repos remain standalone:

| Repo | Purpose |
|------|---------|
| `freeappstore/` | Static HTML storefront (own deploy) |
| `submissions/` | Public issue-intake repo (referenced by CLI + app READMEs) |
| `template-connected/` | Clone-to-scaffold seed for `fas init` (must stay standalone) |
| `template-standalone/` | Clone-to-scaffold seed for `fas init` (must stay standalone) |

## App hosting (Path B)

Apps deploy to R2 via GitHub Actions, not CF Pages:

1. `git push` triggers `.github/workflows/deploy.yml`
2. Builds with `pnpm build`
3. Uploads `web/dist/` to `fas-apps` R2 bucket at `apps/<id>/`
4. Host Worker reads D1 `routes` table, streams from R2

## Auth flow

**Browser:** OAuth web flow (GitHub, Google, Apple) or email magic link -> platform API exchanges code for session token -> HMAC-signed, stored in localStorage.

**CLI:** GitHub device-authorization flow -> user approves in browser -> CLI polls for token -> exchanges for platform session -> cached at `~/.fas/config.json`.

## Data model

All data lives in a single D1 database (`fas`):

- `users` -- identity + session (GitHub, Google, Apple, Email)
- `kv` -- per-user, per-app key-value pairs
- `counters` -- app-wide atomic counters
- `documents` -- document store (collections)
- `apps` -- app registry + ownership
- `app_roles` -- per-app RBAC
- `app_secrets` -- encrypted developer API keys
- `app_proxy_allowlist` -- proxy URL rules
- `proxy_oauth2` -- proxy OAuth2 token state
- `user_api_keys` -- encrypted user key vault
- `key_providers` -- supported key vault providers
- `app_webhooks` -- per-app webhook subscriptions
- `webhook_deliveries` -- webhook delivery log
- `friendships` -- platform-level social graph
- `app_logs` -- client-side app logs (7-day retention)
- `consumed_tokens` -- magic link replay prevention
- `app_analytics` -- visitor analytics
- `health_checks` -- uptime check results
- `audit_results` -- compliance audit results
- `agent_session_logs` -- VibeCode agent build logs

## Cron jobs

| Schedule | Task |
|----------|------|
| `*/15 * * * *` | Uptime checks for all apps |
| `0 3 * * *` | Log prune (>7 days) |
| `0 4 * * *` | D1 -> R2 backup |
| `0 6 * * SUN` | Weekly compliance audit |
