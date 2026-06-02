# workers/

The FAS infrastructure Workers, consolidated into this repo on 2026-06-02 from
their former standalone repos (`freeappstore-online/{admin,agent,host}`).

| Dir | Worker | Role |
|---|---|---|
| `admin/` | `freeappstore-admin` | Privileged provisioning + admin SPA (`web/` → `public/`) |
| `agent/` | `freeappstore-agent` | VibeCode AI builder + `AgentSession` Durable Object |
| `host/`  | `freeappstore-host`  | Path B R2 hosting (`*.freeappstore.online`) |

## Why these are NOT pnpm workspace packages

Each Worker runs a **newer toolchain** than the root `packages/*` workspace
(vitest 4 / TS 6 / biome 2.4 vs. vitest 3 / TS 5 / biome 2.0). To avoid forcing
a single toolchain, each `workers/<name>` stays a **self-contained pnpm project**
with its own `package.json`, lockfile, `tsconfig`, `biome.json`, and tests. They
are deliberately outside `pnpm-workspace.yaml`'s globs, and `workers/` is excluded
from the root `biome.json`.

- `agent/` and `host/` carry their own `pnpm-workspace.yaml` (root marker) so a
  nested `pnpm install` resolves against themselves, not this repo's workspace.
- `admin/` + `admin/web/` are two independent projects (two lockfiles), so their
  installs use `pnpm install --ignore-workspace`.

## Build / test / deploy

Run from inside each worker dir (e.g. `cd workers/host`):

```bash
pnpm install --frozen-lockfile        # admin: add --ignore-workspace
pnpm test
pnpm exec wrangler deploy             # needs CLOUDFLARE_API_TOKEN / _ACCOUNT_ID
```

CI deploys each independently via `.github/workflows/deploy-{admin,agent,host}.yml`,
path-filtered on `workers/<name>/**`, reusing this repo's `CLOUDFLARE_API_TOKEN`.
