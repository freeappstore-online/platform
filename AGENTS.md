# FreeAppStore platform — agent instructions

## Delivery mode

**Straight to `main`. No branches, no pull requests.** Declared 2026-08-16.

### Hard rule: No branches. No pull requests. Ever.

Commit directly to `main`. Do not run `git checkout -b`, `git switch -c`, or `gh pr create`. If you
find yourself on a non-`main` branch, stop and report it. (Declared 2026-08-16.)

## Issue placement: where issues belong

- App issues (epics, features, bugs, compliance, deploy) **must** go on the app's repo,
  `freeappstore-online/<app-id>`, **never** on platform (#265).
- Platform issues (SDK, `fas` CLI, workers/backend, storefront, CI, docs) → file in
  `freeappstore-online/platform`.
- New app: provision with `fas publish` first (it creates the app repo), then open the epic and
  tickets there with `gh issue create --repo freeappstore-online/<app-id> …`.
- Exception: a provisioning ticket filed before the app repo exists may live in platform. It is the
  only app-related issue that does.

See `CONTRIBUTING.md` → "Issue placement".
