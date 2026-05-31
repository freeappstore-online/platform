# FreeAppStore SDK

Free SDK + CLI + backend for apps published on **[freeappstore.online](https://freeappstore.online)**.

Live and self-serve: any developer can scaffold, build, and publish a free app under their own subdomain (`yourapp.freeappstore.online`). Apps are open source, free forever, no tracking.

## Quick start

```bash
npm i -g @freeappstore/cli
fas login                       # GitHub device-flow auth
fas init my-cool-app            # scaffold from the standalone template
cd my-cool-app
pnpm install && pnpm dev        # local dev server
fas check                       # compliance — run before publishing
fas publish                     # provisions repo + hosting + DNS
git push upstream main          # auto-deploys via CI in ~30s
```

Your app is live at `https://my-cool-app.freeappstore.online` and listed on the storefront with a phone-frame preview, recent commits, and a "Recent updates" log sourced from your repo.

Full guide: <https://freeappstore.online/contribute.html>

## What's in here

| Package | npm | Purpose |
|---|---|---|
| [`packages/cli`](./packages/cli) | `@freeappstore/cli` | The `fas` binary — `login`, `init`, `check`, `publish`, `list`, `doctor`, `logs` |
| [`packages/sdk`](./packages/sdk) | `@freeappstore/sdk` | Browser SDK — auth, per-user KV, realtime rooms |
| [`packages/compliance`](./packages/compliance) | `@freeappstore/compliance` | Compliance checks (no-tracking, brand fonts, manifest, bundle size). Runs in `fas check` and in storefront CI. |
| [`packages/backend`](./packages/backend) | _internal_ | The Cloudflare Worker that powers the SDK (Workers + D1 + Durable Objects) |

## Stack

- TypeScript 5.7, Node 22, pnpm workspaces
- **Backend:** Cloudflare Workers + D1 (users, KV, ownership) + Durable Objects (rooms) + R2 (daily backups). One Worker, one D1, one DO class. No Firebase.
- **Auth:** GitHub OAuth (device flow for CLI, web flow for browser). HMAC-signed sessions, 30-day TTL.
- **Realtime:** one Durable Object per room with WebSocket fan-out. Ephemeral, capped — sized for cursors / presence / lightweight multiplayer.
- **Apps:** standalone PWA template (Vite + React + Tailwind) deployed to R2 via GitHub Actions, served by host Worker with custom subdomain.

## What this SDK is *not*

`fas` is the **free** SDK. Pro features — Stripe, paid quotas, premium primitives — live in [`@proappstore/sdk`](https://github.com/proappstore-online) and the `pas` CLI. By design, no paid-only code paths leak into this package.

## Repo layout

```
sdk/
├── packages/
│   ├── cli/         # `fas` binary
│   ├── sdk/         # @freeappstore/sdk (browser-first, ESM)
│   ├── compliance/  # @freeappstore/compliance (CI + local checks)
│   └── backend/     # CF Worker + D1 + Durable Objects
├── docs/
│   └── LIMITS.md    # platform-enforced limits
├── examples/
│   └── rooms-demo/  # minimal SDK consumer
└── scripts/
    └── e2e-local.mjs  # CI integration test against wrangler dev
```

## Contributing

PRs welcome. Run `pnpm install && pnpm -r build && pnpm test` before pushing — CI runs typecheck + 200+ unit tests + an e2e suite against `wrangler dev --local`.

## License

MIT. See [LICENSE](./LICENSE).
