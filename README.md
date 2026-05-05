# FreeAppStore SDK

Free SDK + CLI + backend for apps published on **freeappstore.online**.

> **v0 status: scaffold.** Public API surfaces are stable enough to read; implementations are minimal. See `docs/LIMITS.md` for the hard limits the platform enforces.

## What's in here

| Package | Purpose |
|---|---|
| [`packages/cli`](./packages/cli) | The `fas` CLI — `fas login`, `fas init`, `fas publish`, `fas logs` |
| [`packages/sdk`](./packages/sdk) | `@freeappstore/sdk` — auth, per-user KV, light realtime rooms |
| [`packages/backend`](./packages/backend) | The Cloudflare Worker that powers the SDK (Workers + D1 + Durable Objects) |

## Quick start (when v0 is real)

```bash
npm i -g @freeappstore/cli
fas login
fas init my-cool-app
cd my-cool-app
pnpm dev
fas publish
```

## Stack

- TypeScript 5.7, Node 22, pnpm
- **Backend:** Cloudflare Workers + D1 (users, KV) + Durable Objects (rooms). One Worker, one D1, one DO class. No Firebase.
- **Auth:** GitHub OAuth (device flow for CLI, web flow for browser).
- **Realtime:** Durable Object per room with WebSocket fan-out. Ephemeral, capped — sized for cursors / presence / Slither-grade games, not full multiplayer servers.

## What this SDK is *not*

`fas` is the **free** SDK. Pro features — Stripe, paid quotas, premium primitives — live in [`@proappstore/sdk`](https://github.com/proappstore-online) and the `pas` CLI. By design, no paid-only code paths leak into this package.

## Repo layout

```
sdk/
├── packages/
│   ├── cli/        # `fas` binary
│   ├── sdk/        # @freeappstore/sdk (browser-first, ESM)
│   └── backend/    # CF Worker + D1 + Durable Objects
├── docs/
│   └── LIMITS.md   # platform-enforced limits
└── pnpm-workspace.yaml
```

## License

MIT. See [LICENSE](./LICENSE).
