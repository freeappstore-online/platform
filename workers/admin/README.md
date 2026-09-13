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

## Stack

- Cloudflare Workers (Hono-style routing, but vanilla `fetch` handler).
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
pnpm test                              # 35 unit + integration tests
npx wrangler dev                       # local Worker; uses .dev.vars for secrets
```

`pnpm test` includes a security suite (`src/test/security.test.ts`) that scans the source for known token patterns and previously-leaked credentials. Don't disable it — it's caught real regressions.

## Deploy

Push to `main`. The `.github/workflows/deploy.yml` workflow runs tests, then `wrangler deploy`, then a smoke test against `/docs`. Requires org-level secrets `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID`.

Manual deploy if needed: `pnpm exec wrangler deploy`.

## License

MIT.
