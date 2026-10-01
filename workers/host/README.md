# freeappstore-host

The Worker that serves every published FAS app from R2. Replaces the per-app
R2 project model with one Worker on `*.freeappstore.online`, removing
the 100-projects-per-account R2 ceiling.

## How it works

```
GET https://kanban.freeappstore.online/index.html
  ↓ wildcard DNS routes *.freeappstore.online here
  ↓ Worker reads Host header: "kanban.freeappstore.online"
  ↓ D1 lookup: routes table → slug="kanban", zone="freeappstore.online"
                            → r2_prefix="apps/kanban"
  ↓ R2 GET: fas-apps/apps/kanban/index.html
  ↓ stream body + headers (CSP, MIME, cache-control)
```

Unknown host → 404. Known host, missing asset, no extension → SPA fallback to
the app's `index.html`. Known host, missing asset, has extension → 404 (so
broken JS bundles or images don't silently serve HTML).

## Files

- `src/index.ts` — Worker entry; request → response pipeline
- `src/host.ts` — `resolveRoute()`, `r2KeyFor()`, `contentType()` (testable units)
- `migrations/0001_create_routes.sql` — D1 schema for the routes table
- `wrangler.toml` — bindings + route pattern

## Headers

CSP, X-Frame-Options, X-Content-Type-Options, Referrer-Policy, and HSTS are
emitted from this Worker. Apps no longer need their own `_headers` file —
policy is centralized here. Cache: 60s for HTML, 1 year immutable for assets.

## Secrets needed

Two surfaces consume credentials related to R2 hosting:

| Where | Secrets | Notes |
|---|---|---|
| **This Worker** | None at runtime. The R2 + D1 bindings are declared in `wrangler.toml`; CF auto-injects them. | Nothing to rotate on the Worker itself. |
| **App repos** (`.github/workflows/deploy.yml`) | `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, `R2_ACCOUNT_ID` set as **organization-level** secrets on `freeappstore-online` | One set, every repo inherits. See the [infrastructure inventory](../../docs/architecture.md#infrastructure) for the private secrets source; maintainers manage rotation there. |

The R2 access key should be scoped to **Object Read & Write on `fas-apps`
only** (least privilege — keeps the deploy creds away from `fas-backups`,
`pas-storage`, `pws-media`).

## When things go wrong

- Worker itself failing → [Bad Worker deploy recovery](../../ops/DR.md#scenario-3-bad-worker-deploy)
- R2 bucket lost data (backup limitations) → [Backup limitations](../../ops/DR.md#backups-gap-to-close)
- D1 `routes` table drift → [D1 corruption recovery](../../ops/DR.md#scenario-2-d1-corruption-accidental-drop-bad-migration)
- Wildcard DNS broken → [DNS recovery](../../ops/DR.md#scenario-4-dns-misconfiguration)

## Local dev

```bash
pnpm install
pnpm test          # unit tests (vitest)
pnpm lint          # biome
pnpm typecheck     # tsc
wrangler dev       # local with miniflare's R2 + D1 stubs
```

## Deploy

```bash
wrangler deploy
```

Migrations are applied automatically by wrangler against the bound D1
database the first time they're seen.
