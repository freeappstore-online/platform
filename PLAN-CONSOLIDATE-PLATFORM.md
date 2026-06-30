# Plan: Consolidate platform tooling into one `platform` monorepo

> **Goal:** collapse the FAS platform-tooling repos (currently spread across many
> `freeappstore-online/*` repos) into a single `platform` monorepo. Published apps
> (`apps/*`), public-intake, and clone-to-scaffold repos stay standalone — see
> "Stays standalone" below for why.
>
> Supersedes the narrower `PLAN-CONSOLIDATE-WORKERS.md` (admin/agent/host Workers,
> folded into `workers/` on 2026-06-02) — that doc was removed 2026-06-30 as stale;
> its rationale (privileged Workers stay separate per `admin-worker-per-store`)
> lives in the workspace `CLAUDE.md` + git history.
>
> Started 2026-06-30. Status legend: ✅ done · 🔜 pending verification · ⬜ not started.

## Already done (2026-06-30, earlier this session)

- ✅ `admin`, `agent`, `host` — stale standalone clones deleted; remotes
  `freeappstore-online/{admin,agent,host}` **archived**. Canonical lives in
  `workers/{admin,agent,host}`, deployed by `deploy-{admin,agent,host}.yml`.
  (These were exact duplicates of the `workers/` copies — the only true
  duplication in the tree.)

## Execution log (2026-06-30, "push all")

- ✅ Code for all 6 repos folded into `platform`: `workers/{mcp,publisher}`,
  `sites/{console,create}`, `brand/`, `ops/`. `biome.json` extended to ignore
  `!sites !brand !ops` (mirrors existing `!workers`) so folded code doesn't redden
  platform lint.
- ✅ `population-agent` top-level clone deleted (dup of `apps/population-agent`).
- ✅ New deploy workflows added **dispatch-only**: `deploy-mcp.yml` (npm),
  `deploy-console.yml`, `deploy-create.yml` (pnpm, hardcoded R2 prefix). Push
  triggers are commented out until G4 secrets are provisioned + first run verified.
- ✅ `brand` + `ops` remotes archived; local clones deleted (zero deploy risk).
- ✅ **Cutover verified & complete.** Dispatch runs of `deploy-mcp`,
  `deploy-console`, `deploy-create` all green from the monorepo (incl. the R2
  upload — confirming the R2 creds are **org-level secrets** inherited by
  `platform`, so G4 needed no provisioning). Post-cutover live checks: all 200 —
  `console.freeappstore.online`, `console.freeappstore.online/create`,
  `mcp.freeappstore.online` (protocol endpoints 405/406 = healthy).
- ✅ Push triggers enabled on all three deploy workflows.
- ✅ `mcp` / `console` / `create` / `publisher` remotes **archived**; local clones
  deleted.

### Publisher decommission — ✅ DONE (2026-06-30)

The `freeappstore-publisher` worker is fully decommissioned:

- **Root cause found:** publisher was redundant legacy — its provisioning is
  duplicated by the canonical `backend /v1/publish` (session-auth → admin Worker,
  Path B), and it used a *different* auth model (Cloudflare Access) plus the
  abandoned CF Pages provisioning path. Its only consumer was the create site's
  `/publish` page.
- **Migrated:** `sites/create/web/src/pages/Publish.tsx` now POSTs
  `api.freeappstore.online/v1/publish` with the platform session (the auth the
  rest of the site already uses) and lists apps via `GET /v1/apps/mine`. Dropped
  the Path-B-obsolete "publish existing" form, per-app icon fields (admin assigns
  the icon), and the games option. Verified: deployed page 200, both endpoints
  401 unauth, live bundle has 0 `publish.freeappstore.online` refs.
- **Worker deleted:** `wrangler delete freeappstore-publisher` (2026-06-30).
  Source removed from `workers/publisher`; recoverable from git history if needed.
- **Console link** repointed to `create.freeappstore.online/publish`; host routing
  comment + create CLAUDE.md updated.
- **Orphans needing CF dashboard cleanup** (token lacks DNS/Access edit scope):
  the `publish.freeappstore.online` DNS record + its Cloudflare Access application
  still exist, so the subdomain 302s to an Access login that now leads nowhere.
  Harmless; delete the DNS record + Access app to fully tidy.

Consolidation is complete: every foldable platform-tooling repo is in `platform`,
all legacy/stale leftovers removed.

## Fold into `platform` (6 repos)

| Repo | Current role | Lands at | Deploy rewiring | Status |
|---|---|---|---|---|
| `mcp` | MCP server (`mcp.freeappstore.online`) | `workers/mcp/` | new `deploy-mcp.yml`, path-filtered. **Uses npm (`package-lock.json`), NOT pnpm** — `npm ci` + `npx wrangler deploy`, do NOT mirror the pnpm-based `deploy-admin.yml` install step. Keep `wrangler.toml` route `mcp.freeappstore.online/*`. Worker name `freeappstore-mcp` (no collision). | ⬜ |
| `publisher` | Legacy publish Worker — still serves `/api/me`, `/api/create`, `/api/publish-existing` | `workers/publisher/` | **Source-only fold.** Publisher has NO CI deploy workflow today (deployed manually/historically); the live `freeappstore-publisher` worker is untouched by this move. Vendor the source in for retirement prep, then port the 3 endpoints into `packages/backend` and decommission. No `deploy-publisher.yml` until/unless we choose to manage it from CI. | ⬜ |
| `console` | Creator portal SPA (`console.freeappstore.online`) | `sites/console/` | new `deploy-console.yml` — **hardcode R2 prefix `apps/console/`** (repo-name derivation `${GITHUB_REPOSITORY##*/}` resolves to `platform` in the monorepo). **Nested pnpm workspace** — see Gotcha G3. Needs R2 S3 secrets on platform repo — see G4. | ⬜ |
| `create` | Onboarding/scaffold site | `sites/create/` | new `deploy-create.yml` — **hardcode R2 prefix `apps/create/`**. Same nested-workspace (G3) + R2-secrets (G4) caveats. | ⬜ |
| `brand` | Brand assets + `BRAND.md`/`SKILLS.md` | `brand/` | none (content only). **Archive, don't delete** the remote — if any app references brand assets by raw URL, archived repos stay readable; deleting would break them. (No such refs found in `fas`/`landing`/`docs`, but apps/* not exhaustively scanned.) | ⬜ |
| `ops` | Ops docs (DR, infra, submission) + scripts | `ops/` | none (content only). No URL refs to `freeappstore-online/ops` found. | ⬜ |

## Delete (stale duplicate, no fold)

| Repo | Why | Action | Status |
|---|---|---|---|
| `population-agent` (top-level clone) | Same remote as `apps/population-agent` — a stray duplicate clone on disk | Delete local clone; canonical stays in `apps/`. No archival. | ⬜ |

## Stays standalone (cannot / should not fold)

| Repo | Reason |
|---|---|
| `submissions` | Public issue-intake repo. Referenced by `packages/cli` (`publish.ts`), `publisher`, and ~50 app READMEs as `freeappstore-online/submissions`. Folding changes where issues are filed and breaks those URLs. |
| `templates/template-connected` | `fas init` runs `git clone https://github.com/freeappstore-online/template-connected.git` — must remain a standalone, public, clonable repo. |
| `templates/template-standalone` | Same — cloned by URL to scaffold new apps. |
| `freeappstore` | Public storefront / marketing site (`freeappstore.online`), independent deploy. It is the product's public face, not dev tooling. **Default: keep separate.** Optional: could fold as `sites/storefront/` if desired. |
| `apps/*` (109) | Published apps — one-repo-per-app by design (per-repo GitHub Actions → R2 + registry entry). Never fold. |

## End-state `platform/` layout

```
platform/
├── packages/        backend, cli, sdk, compliance, quality, e2e, kb-host …   (existing)
├── workers/         admin, agent, host                                       (existing)
│                  + mcp, publisher                                           (NEW)
├── sites/         + console, create                                          (NEW dir)
├── brand/         + brand assets                                             (NEW)
├── ops/           + ops docs & scripts                                       (NEW)
├── docs/, migrations/, scripts/, examples/ …                                 (existing)
└── .github/workflows/
        deploy-admin / agent / host / backend / kb-host                       (existing)
      + deploy-mcp / deploy-console / deploy-create                           (NEW, path-filtered)
```

`workers/*` and `sites/*` are **self-contained projects** (each its own
`package.json` + lockfile), outside the root pnpm workspace globs
(`packages/*`, `examples/*`), so they don't pollute the monorepo workspace —
same arrangement as the existing `workers/admin|agent|host`. Their CI installs
use `--ignore-workspace`.

## Repo count

| Stage | Non-app repos |
|---|---|
| Session start | 13 (`admin`,`agent`,`host` + 10) + 2 templates |
| After admin/agent/host fold | 10 + 2 templates |
| **After this plan** | **`platform` + `freeappstore` + `submissions` + 2 templates = 5** |

From 15 non-app repos → **5** (or **4** if `freeappstore` also folds). `apps/*` (109) untouched throughout.

## Prerequisites & gotchas (verified against the code 2026-06-30)

- **G1 — `mcp` is npm, the other Workers are pnpm.** `deploy-mcp.yml` must use
  `npm ci` + `npx wrangler deploy`. Mirroring `deploy-admin.yml`'s pnpm install
  verbatim will fail.
- **G2 — Host routing is D1-table-driven, not derived.** `workers/host` resolves
  `r2_prefix` via `SELECT slug, zone, r2_prefix, store FROM routes WHERE slug=?`.
  The live `console`/`create` routes already point at `apps/console` / `apps/create`
  (that's where the current per-repo deploy writes). The fold MUST preserve those
  exact prefixes so **no `routes` row changes** — verify the rows before and after.
  If the prefix drifts, the live subdomain 404s.
- **G3 — `console`/`create` are nested pnpm workspaces.** Each has its own
  `pnpm-workspace.yaml` + a `web/` member, and builds via
  `pnpm --filter @<name>/web build`. Dropped under `platform/` (itself a pnpm
  workspace) this is a workspace-inside-a-workspace; `--filter` resolves against
  the wrong root unless handled. Pick ONE on fold:
  (a) **flatten** — hoist `web/*` to `sites/<name>/`, drop the wrapper
  `pnpm-workspace.yaml`, making it a single package (cleanest); or
  (b) keep nested, run the deploy with `working-directory: sites/<name>` so pnpm
  roots at the nearest `pnpm-workspace.yaml`. **Riskiest step** — covered by the
  keep-remote-live gate below.
- **G4 — R2 S3 secrets must exist on the `platform` repo.** `console`/`create`
  upload via `aws s3 sync` needing `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`,
  `R2_ACCOUNT_ID`. Platform's Worker deploys use `CLOUDFLARE_API_TOKEN` and likely
  lack the R2 S3 creds. Provision them on `freeappstore-online/platform`
  (Doppler → GH) **before** the first `deploy-console`/`deploy-create` run.
- **G5 — `mcp` Durable Object migration.** `wrangler.toml` declares
  `new_sqlite_classes = ["FasMcpAgent"]` (tag `v1`). Redeploy from the new location
  is idempotent (applied migrations skip); the DO namespace is keyed by the
  unchanged worker name `freeappstore-mcp`. No data migration.

## Execution safety model

- **Content folds** (`brand`, `ops`) + **dedup** (`population-agent`): archive
  remote / delete immediately — zero deploy risk.
- **Deploy-bearing folds** (`mcp`, `console`, `create`): copy code into `platform`
  + wire path-filtered workflows, commit — but **keep the source remotes live until
  the first platform-driven deploy is verified green** (and, for console/create,
  the live subdomain still 200s from the preserved R2 prefix — G2), then archive.
  Avoids breaking `mcp.freeappstore.online` / `console.freeappstore.online` on a
  workflow bug.
- **`publisher`**: source-only fold (no CI deploy exists; live worker untouched).
  Safe to vendor in immediately; archive the remote only after the 3 endpoints are
  ported into `backend` and the live worker is decommissioned — not before.
- All source repos verified clean + pushed before any local clone is deleted.
  (`create` has an untracked `web/test-results/`, `publisher` a modified
  `test-results/results.json` — both gitignorable noise, not real work.)

## Open decision

- **`freeappstore` — fold or keep separate?** Default in this plan: keep separate.

## Repo-takeover / supply-chain risk assessment (2026-06-30)

Verified after the consolidation + archival. **Overall risk: LOW.**

- **Subdomain takeover — none.** `publish.freeappstore.online` (worker deleted)
  resolves to Cloudflare-proxied IPs (104.21.x / 172.67.x), not an external CNAME
  to a claimable SaaS. The orphaned DNS routes into CF where nothing serves it
  (CF Access gate → dead end). No external resource for an attacker to provision.
- **Repo-name reclamation — none.** All 9 retired repos (`admin`, `agent`, `host`,
  `brand`, `ops`, `mcp`, `console`, `create`, `publisher`) are **archived, not
  deleted** — the org still owns every name; none can be re-registered.
- **Org-level guard — confirmed.** `freeappstore-online` has
  `members_can_create_repositories: false` (public too), so even a freed name
  couldn't be created by a non-owner.
- **Templates — kept, not archived (correct).** `template-standalone` /
  `template-connected` must stay clonable for `fas init`. They are the real
  supply-chain surface (a malicious push to a template injects code into every
  new app), but that's pre-existing and unchanged by this work.

**Standing rules to keep this LOW (do not violate):**
1. **Never hard-delete** the 9 archived repos. Archived (read-only, name-owned)
   is the safe terminal state; deletion frees the public name for reclamation.
2. **Never delete the template repos**, and treat write access to them as
   privileged (supply-chain blast radius = every scaffolded app).
3. **Keep org repo-creation locked.** Re-enabling it without a drift-reconcile
   cron reopens both the takeover and the unregistered-repo-drift surfaces.
4. The `publish.freeappstore.online` DNS record + CF Access app are harmless
   orphans; deleting them (dashboard, needs DNS/Access scope) is tidy-up, not
   security-critical.

---
*Consolidation session closed 2026-06-30. See git history on this repo for the
full change set (commits from 586c0ae onward).*
