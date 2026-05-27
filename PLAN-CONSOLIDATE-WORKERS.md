# Plan: Phase A — Static sites + publisher redirect

> **Phases B and C were dropped 2026-05-28.** They proposed merging the admin
> and agent Workers into the platform backend. That direction contradicts the
> `admin-worker-per-store` principle set 2026-05-21 (FWS admin canonical;
> each store owns its own privileged provisioning Worker). Folding the
> privileged Worker into the public-facing platform Worker also enlarges
> blast radius (auth + KV + provisioning + AI streaming in one Worker).
>
> Cross-store admin cleanup now lives in
> `../../PLAN-ARCH-CLEANUP.md` (workspace root).

## Goal (Phase A only)

- `create` repo deploys to R2 via GitHub Actions (mirror of `console`).
- `host` Worker routes `create.freeappstore.online` and `console.freeappstore.online` via the same R2 path lookup it uses for apps.
- `publish.freeappstore.online` redirects 301 → `console.freeappstore.online`. Publisher Worker becomes redundant and can be deleted.

## Status (2026-05-28)

- T1: ✅ `create/.github/workflows/deploy.yml` exists.
- T2: ✅ `console` + `create` serve 200 on their subdomains.
- T3: 🟡 Redirect entry exists at `fas/host/src/index.ts:40` but the legacy
  `freeappstore-publisher` Worker is still deployed and its more-specific
  route preempts the host wildcard. Deletion handled by Phase 2 of
  `../../PLAN-ARCH-CLEANUP.md`.

## What stays out of this plan

- Worker consolidation. No more "9 → 5" target. Per-store independence is
  the principle; reducing Worker count within a store is not a goal.
- Admin / agent / publisher merges. The admin Worker is privileged and stays
  separate; the agent Worker has its own DO + API key and stays separate;
  the publisher Worker is being deleted, not merged.
