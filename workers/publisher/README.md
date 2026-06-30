# freeappstore-publisher

Cloudflare Worker for **self-service app publishing** on [FreeAppStore](https://freeappstore.online) and [FreeGameStore](https://freegamestore.online).

Lives at `publish.freeappstore.online`. Authenticated by Cloudflare Access (GitHub sign-in).

## What it does

Takes a deployed app (repo already exists) and makes it live on the store.

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/api/me` | GET | Returns creator info: GitHub user, published apps, slots remaining |
| `/api/create` | POST | Full publish: creates repo from template, CF Pages project, DNS CNAME, custom domain, registry entry, org team access |
| `/api/publish-existing` | POST | Publish an already-deployed CF Pages app: adds custom domain + DNS + registry entry. Used by `create.freeappstore.online/publish` for apps built via the AI agent. |

## Publish flow

```
POST /api/create
{
  "id": "calendar",
  "name": "Calendar",
  "category": "utilities",
  "icon": "📅",
  "iconBg": "#f0fdf4",
  "description": "Simple calendar app",
  "store": "apps"          // "apps" or "games"
}
```

Steps performed:
1. Create GitHub repo from template (`template-standalone` or `template-game-canvas`)
2. Create CF Pages project (`free{id}app`) with GitHub source
3. Add custom domain (`{id}.freeappstore.online`)
4. Add DNS CNAME (`{id}` → `free{id}app.pages.dev`)
5. Add entry to `registry.json` in store repo
6. Create issue in `submissions` repo for admin review
7. Add creator to org `creators` team + give push access to their repo

## Rate limiting

- Per-user app limit stored in `CREATORS` KV namespace
- Default: 5 apps per user (configurable via `MAX_APPS_PER_USER`)
- Banned users get 403

## Auth

Cloudflare Access (GitHub identity provider). User identity extracted from the CF Access JWT.

## Secrets

```bash
wrangler secret put GITHUB_TOKEN    # org-wide repo/team access
wrangler secret put CF_API_TOKEN    # CF Pages project creation
wrangler secret put CF_GLOBAL_KEY   # DNS CNAME creation
wrangler secret put CF_EMAIL        # pairs with CF_GLOBAL_KEY
```

## Develop

```bash
pnpm install
npx wrangler dev
```

## Deploy

```bash
npx wrangler deploy
```

## Frontend

The publisher UI lives in the VibeCode app at `create.freeappstore.online/publish` (`platform/create/web/src/pages/Publish.tsx`).
