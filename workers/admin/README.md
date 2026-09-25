# freeappstore-admin

The Cloudflare Worker that handles **provisioning** for [FreeAppStore](https://freeappstore.online/contribute.html) and [FreeGameStore](https://freegamestore.online). When a creator runs `fas publish`, this worker creates the GitHub repo, the R2 hosting route, the DNS record, the custom subdomain, and the storefront registry entry — atomically, in one call.

Lives at `admin.freeappstore.online`. Humans sign in with the normal FAS GitHub OAuth session; the api worker reaches it over a service binding and authenticates with the shared internal token.

## What it does

`POST /api/provision` — given an app/game id, name, category, store ('apps' | 'games'), creates:

| Step | Action |
|---|---|
| 1. GitHub repo | `POST /orgs/<org>/repos` (empty repo, `auto_init: false`) so the user's `fas init` substitutions are the canonical first commit. |
| 2. R2 hosting route | Inserts row in D1 `routes` table — host worker serves app content from R2. |
| 3. Custom domain | `<id>.freeappstore.online` or `.freegamestore.online`. |
| 4. DNS CNAME | `<id>` pointing to the host worker on the right zone. |
| 5. Store registry | Appends entry to the storefront repo's `registry.json` (so the storefront listing page picks it up on next build). |

If step 2 or 3 fails, step 5 is skipped to avoid leaving dead-link entries on the storefront.

`GET /api/status?store=apps|games` — fast registry read, used by the dashboard. With `?detail=true`, hits CF API per-app for live deployment status.

`GET /docs` — public-facing API reference (the page rendered at `admin.freeappstore.online/docs`).

## Which APIs live here vs the backend

The rule: **this worker owns provisioning and anything that needs its privileged credentials** (GitHub org token, CF DNS/RUM token, the `fas-apps` R2 bucket). **Everything else a browser admin console needs belongs in the backend**, at `packages/backend/src/routes/content-admin.ts` behind platform session auth. Do not add new browser-facing read APIs here.

| Route module (`src/routes/`) | Paths | Belongs here? |
|---|---|---|
| `ping.ts` | `GET /api/ping` | Yes — backend `/status` probe of the service-binding auth path. |
| `provision.ts` | `POST /api/provision` | Yes — creates repos, routes, DNS, registry entries. |
| `deprovision.ts` | `POST /api/unpublish`, `POST /api/deprovision` | Yes — the inverse of provision. |
| `dns.ts` | `POST /api/fix-dns` | Yes — needs the CF DNS token. |
| `reports.ts` | `PUT /api/test-report` (CI), `GET /test-report` | Yes — CI upload with `X-CI-Token`. |
| `apps.ts` | `/api/apps/all`, `/api/apps/deploy-status`, `/api/apps/:id/{deploy-status,health,sessions}` | Yes for deploy-status (uses the org GitHub token; the backend proxies it to creators). The rest are admin-console reads. |
| `ai-keys-proxy.ts` | `/api/ai-keys/*`, `/api/ai-grants*` | Transitional — a thin proxy to backend `/v1/internal/keys/*`. |
| `content-proxy.ts` | `/api/content/{kv,kv/value,collections,counters}` | Transitional — proxy to backend `/v1/internal/admin/*`; the backend already serves `/v1/admin/{kv,collections,counters}` directly. |
| `stats.ts` | `GET /api/stats` | Migrate — backend has `/v1/admin/stats`. |
| `creators.ts` | `GET /api/users`, `GET /api/creators` | Migrate `/api/users` (backend has `/v1/admin/users`). `/api/creators` stays: the backend's `/v1/admin/creators` reads it over the `ADMIN` binding. |
| `agent-sessions.ts` | `/api/agent/sessions`, `/api/agent/sessions/:id` | Migrate — backend has `/v1/admin/agent-sessions[/:id]`. |

"Migrate" routes are still called by the admin SPA in `web/src/` (Overview, AgentSessions, AgentSessionView, ContentData), so removing them here means pointing those screens at the backend first. Until then they stay, unchanged.

`src/index.ts` is only the shell: CORS preflight, the single `/api/*` auth gate (`src/auth.ts`), and an ordered list of route modules — each returns a `Response` if it owns the request, or `null` to pass. Add a route by adding a module and listing it in `ROUTES`; tests for each module live in `src/test/routes.test.ts`.

## Stack

- Cloudflare Workers, vanilla `fetch` handler dispatching to route modules in `src/routes/`.
- TypeScript, vitest for tests.
- No build step — `wrangler deploy` bundles directly from `src/`.

## Auth

- **Humans:** the SPA redirects through `api.freeappstore.online/v1/auth/github/start`, stores the returned `fas:session`, and sends it as `Authorization: Bearer <session>` to `/api/*`. The Worker verifies that session through the `BACKEND_FAS` service binding and requires the returned roles to include `admin`. Admin membership is controlled by the backend's `ADMIN_GITHUB_LOGINS` / `ADMIN_USER_IDS` configuration.
- **Service:** the api worker calls in via service binding (`env.ADMIN.fetch(...)`). Service-binding calls bypass the edge entirely, so they never see CF Access; they authenticate to this Worker with `X-Internal-Token: ADMIN_PROVISION_TOKEN` instead.

Do **not** add a Cloudflare Access application in front of `admin.freeappstore.online`. It blocks the SPA before FAS auth can run and has broken before when the Zero Trust team domain changed.

Secrets for GitHub + DNS + D1 calls are managed in the private SOPS repo
`serge-ivo/secrets` (`~/dev/secrets`) and pushed to Cloudflare on rotation/touch:

```bash
cd ~/dev/stores/fas/platform
SECRETS_PROJECT=fas bash scripts/sync-worker-secrets.sh workers/admin
```

## Develop

```bash
pnpm install
pnpm test                              # unit + integration tests (vitest)
npx wrangler dev                       # local Worker; uses .dev.vars for secrets
```

`pnpm test` includes a security suite (`src/test/security.test.ts`) that scans the source for known token patterns and previously-leaked credentials. Don't disable it — it's caught real regressions.

## Deploy

Push to `main`. The `.github/workflows/deploy.yml` workflow runs tests, then `wrangler deploy`, then a smoke test against `/docs`. Requires org-level secrets `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID`.

Manual deploy if needed: `pnpm exec wrangler deploy`.

## License

MIT.
