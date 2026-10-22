# FreeAppStore platform

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
git remote add upstream https://github.com/freeappstore-online/my-cool-app.git
git push upstream main          # use the remote/push commands printed by fas publish
```

Your app is live at `https://my-cool-app.freeappstore.online` and listed on the storefront with a phone-frame preview, recent commits, and a "Recent updates" log sourced from your repo.

Full guide: <https://freeappstore.online/contribute.html>

## What's in here

| Package | npm | Purpose |
|---|---|---|
| [`packages/cli`](./packages/cli) | `@freeappstore/cli` | The `fas` binary — `login`, `init`, `check`, `publish`, `list`, `doctor`, `logs` |
| [`packages/sdk`](./packages/sdk) | `@freeappstore/sdk` | Browser SDK — auth, KV, collections, counters, rooms, roles, friends, proxy, keys, email, push, hooks, and UI |
| [`packages/compliance`](./packages/compliance) | `@freeappstore/compliance` | Compliance checks (no-tracking, brand fonts, manifest, bundle size). Runs in `fas check` and in storefront CI. |
| [`packages/backend`](./packages/backend) | _internal_ | The Cloudflare Worker that powers the SDK (Workers + D1 + Durable Objects) |

## Stack

- TypeScript (per-package versions), Node 22+, pnpm 10 workspaces
- **Backend:** Cloudflare Workers + D1 (users, KV, ownership) + Durable Objects (rooms) + R2 (daily backups). The API is one Worker; hosting, provisioning, AI builds, MCP, and docs use separate Workers in this monorepo.
- **Auth:** GitHub device flow for CLI; GitHub, Google, Apple, or email magic links for browser sign-in (subject to configured credentials). HMAC-signed sessions, 30-day TTL.
- **Realtime:** one Durable Object per room with WebSocket fan-out. Ephemeral, capped — sized for cursors / presence / lightweight multiplayer.
- **Apps:** standalone PWA template (Vite + React + Tailwind) deployed to R2 via GitHub Actions, served by host Worker with custom subdomain. Every app is built on the SDK `Shell` with one `nav` entry per screen: see [Build your app on the Shell](docs/getting-started.md#build-your-app-on-the-shell).

## What this SDK is *not*

`fas` is the **free** SDK. Pro features — Stripe, paid quotas, premium primitives — live in [`@proappstore/sdk`](https://github.com/proappstore-online) and the `pas` CLI. By design, no paid-only code paths leak into this package.

## Repo layout

```
platform/
├── packages/
│   ├── cli/         # `fas` binary
│   ├── sdk/         # @freeappstore/sdk (browser-first, ESM)
│   ├── compliance/  # @freeappstore/compliance (CI + local checks)
│   ├── backend/     # API Worker + D1 + Durable Objects
│   ├── quality/     # quality reporter and scanner
│   ├── kb-host/     # docs and app knowledge-base host
│   └── e2e/         # live browser tests
├── docs/
│   └── platform-limits.md # maintained server-enforced limits
├── workers/        # admin, agent, host, mcp (independent projects)
├── sites/          # storefront and creator console
├── brand/          # shared identity and design conventions
├── ops/            # operational docs and scripts
├── examples/
│   └── rooms-demo/  # minimal SDK consumer
└── scripts/
    └── e2e-local.mjs  # CI integration test against wrangler dev
```

## Contributing

Work goes straight to `main` — no branches or pull requests. See [CONTRIBUTING.md](./CONTRIBUTING.md) for the workflow, how Dependabot updates are handled, and how outside contributors can propose changes.

## License

MIT. See [LICENSE](./LICENSE).
