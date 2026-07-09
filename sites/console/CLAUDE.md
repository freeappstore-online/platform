# Creator Console

Creator portal for FreeAppStore developers.

- **Canonical URL:** `https://freeappstore.online/app/` (path-based, not a subdomain).
- Dev: `pnpm install && pnpm dev`
- Build: `pnpm build`
- Deploy: `git push origin main` (auto-deploys to R2 via GitHub Actions →
  `deploy-console.yml`, R2 prefix `apps/console`).

## How it's served (read before touching `vite.config.ts`)

The console is served under the storefront apex at **`/app/`** so the login
session stays on one origin (`freeappstore.online`) — no cross-subdomain OAuth /
cookie problems. Same pattern as the PAS console.

The wiring:

1. `freeappstore/functions/app/[[path]].ts` (a CF Pages Function on the
   storefront) catches `freeappstore.online/app/*`, **strips the `/app` prefix**,
   and proxies to the console origin `console.freeappstore.online`.
2. `console.freeappstore.online` is the internal R2 origin (`apps/console`) the
   proxy fetches from. It is **not** the user-facing URL anymore — don't link to
   it. It still resolves directly, which is fine (relative base works there too).

**`base` MUST stay `'./'` (relative)** in `vite.config.ts`. With the default
`base: '/'` the built HTML asks for `/assets/*`, `/manifest.webmanifest`,
`/registerSW.js` at the apex root — which bypass the `/app/*` proxy and hit the
storefront's 404 (CSS served as `text/html`, JS/manifest/SW 404, blank app).
Relative `./` emits `./assets/*`, which resolve to `/app/assets/*` under the
proxy. The PWA manifest keeps `start_url`/`scope` = `/app/` with relative icon
`src`. Mirror `pas/apps/console/web/vite.config.ts` if in doubt.

For platform conventions, read
https://freeappstore.online/skills.md
before writing or changing anything.
