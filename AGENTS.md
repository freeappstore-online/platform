# FreeAppStore platform — agent instructions

## Delivery mode

**Straight to `main`. No branches, no pull requests.** Declared 2026-08-16.

### Hard rule: No branches. No pull requests. Ever.

Commit directly to `main`. Do not run `git checkout -b`, `git switch -c`, or `gh pr create`. If you
find yourself on a non-`main` branch, stop and report it. (Declared 2026-08-16.)

## Where issues belong

- App issues (features, bugs, compliance, deploy) → file in `freeappstore-online/<app-id>`.
- Platform issues (SDK, `fas` CLI, workers/backend, storefront, CI, docs) → file in
  `freeappstore-online/platform`.
- Exception: provisioning tickets (creating the app repo) go in platform because the app repo
  does not exist yet.
- When planning tickets for an app epic, use `gh issue create --repo freeappstore-online/<app-id> …`.

See `CONTRIBUTING.md` → "Where issues belong".
