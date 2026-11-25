# workers/

The FAS infrastructure Workers, consolidated into this repo on 2026-06-02 from
their former standalone repos (`freeappstore-online/{admin,agent,host}`).

| Dir | Worker | Role |
|---|---|---|
| `admin/` | `freeappstore-admin` | Privileged provisioning + admin SPA (`web/` → `public/`) |
| `agent/` | `freeappstore-agent` | VibeCode AI builder + `AgentSession` Durable Object |
| `mcp/` | `freeappstore-mcp` | MCP discovery, authentication, SDK reference, and build tools |
| `host/`  | `freeappstore-host`  | Path B R2 hosting (`*.freeappstore.online`) |

## Why these are NOT pnpm workspace packages

Each Worker declares its own toolchain versions in its package metadata. To avoid forcing
a single toolchain, each `workers/<name>` stays a **self-contained pnpm project**
with its own `package.json`, lockfile, `tsconfig`, `biome.json`, and tests. They
are deliberately outside `pnpm-workspace.yaml`'s globs, and `workers/` is excluded
from the root `biome.json`.

- `agent/`, `host/` and `mcp/` carry their own `pnpm-workspace.yaml` (root marker)
  so a nested `pnpm install` resolves against themselves, not this repo's workspace.
- `admin/` + `admin/web/` are two independent projects (two lockfiles), so their
  installs use `pnpm install --ignore-workspace`.

## Build / test / deploy

Run from inside each worker dir (e.g. `cd workers/host`):

```bash
pnpm install --frozen-lockfile        # admin: add --ignore-workspace
pnpm lint && pnpm run typecheck && pnpm test
pnpm exec wrangler deploy             # needs CLOUDFLARE_API_TOKEN / _ACCOUNT_ID
```

All four use TypeScript 5.9, Biome 2 and Vitest 4 (`@cloudflare/vitest-pool-workers`,
which runs the runtime suites, does not support Vitest 5 yet; the root packages use 5).

CI deploys each independently via `.github/workflows/deploy-{admin,agent,host,mcp}.yml`,
path-filtered on `workers/<name>/**` plus the shared source each imports, reusing this
repo's `CLOUDFLARE_API_TOKEN`. Every deploy runs lint, typecheck and the unit tests
first (plus the runtime suite), the same steps `ci.yml`'s `worker-tests` job runs.
