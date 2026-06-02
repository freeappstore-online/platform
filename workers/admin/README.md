# freeappstore-admin

The Cloudflare Worker that handles **provisioning** for [FreeAppStore](https://freeappstore.online/contribute.html) and [FreeGameStore](https://freegamestore.online). When a creator runs `fas publish`, this worker creates the GitHub repo, the R2 hosting route, the DNS record, the custom subdomain, and the storefront registry entry — atomically, in one call.

Lives at `admin.freeappstore.online`. Authenticated by Cloudflare Access (Google sign-in for humans, service tokens for the api worker's service binding).

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

- **Humans:** Cloudflare Access policy fronting the worker's domain. Google sign-in.
- **Service:** the api worker calls in via service binding (`env.ADMIN.fetch(...)`). Service-binding calls bypass the edge entirely, so they bypass CF Access too — both workers are trusted internal.

Secrets for GitHub + DNS + D1 calls are managed in Doppler (`fas` project) and set via:

```bash
doppler secrets --project fas --config prd  # view all
wrangler secret put GH_TOKEN           # PAT with admin:org + repo scopes
wrangler secret put STORE_GH_TOKEN     # PAT for the storefront registry repo writes
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
