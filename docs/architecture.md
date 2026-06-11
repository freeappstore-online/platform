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
└── packages/e2e         End-to-end tests
```

## Services

| Service | URL | Worker |
|---------|-----|--------|
| Store | freeappstore.online | Static (CF Pages) |
| API | api.freeappstore.online | freeappstore-api |
| Host | *.freeappstore.online | freeappstore-host |
| Admin | admin.freeappstore.online | freeappstore-admin |
| Console | console.freeappstore.online | CF Pages |
| VibeCode | create.freeappstore.online | CF Pages |
| Publisher | publish.freeappstore.online | freeappstore-publisher |
| Docs | docs.freeappstore.online | freeappstore-kb-host |
| KB | kb.freeappstore.online | freeappstore-kb-host |
| MCP | mcp.freeappstore.online | freeappstore-mcp |

## Companion repos

| Repo | Purpose |
|------|---------|
| `freeappstore/` | Static HTML storefront |
| `admin/` | Provisioning + moderation worker |
| `agent/` | VibeCode AI app builder |
| `create/` | VibeCode React frontend |
| `console/` | Creator portal |
| `host/` | R2 host worker |
| `mcp/` | MCP server (12 tools) |
| `publisher/` | Self-service publish worker |

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
