# Contributing

## Issue placement: where issues belong

| Topic | File issues in |
|---|---|
| App epics, features, bugs, compliance checks, deploy tickets | `freeappstore-online/<app-id>` (the app's own repository, e.g. `freeappstore-online/cycle`, `freeappstore-online/carebook`) |
| SDK (`packages/`), `fas` CLI, workers / backend, storefront, CI pipelines, platform docs | `freeappstore-online/platform` (this repo) |

**Rule (#265):** app issues **must** be opened on the app's repository, **never** on platform.
This repo is only for platform work.

**New apps:** provision first with `fas publish`, which creates `freeappstore-online/<app-id>`. Then
open the app's epic and its tickets there:
`gh issue create --repo freeappstore-online/<app-id> …`. The one exception is a provisioning
ticket filed before the app repository exists. That may live in platform, and it is the only
app-related issue that does.

## Direct to `main`, no branches or pull requests

This repo does not use feature branches or pull requests (#71). All work,
including by coding agents, is committed and pushed directly to `main`:

1. **Start from an issue.** Read it and all its comments before changing code.
2. **Sync first:** `git pull --ff-only` (rebase onto `origin/main` if you have
   local commits). Never force-push `main`.
3. **Work on `main` locally.** No `git checkout -b`, no `gh pr create`, even
   when CI would pass.
4. **Check before pushing.** From the repo root:
   `pnpm install && pnpm -r build && pnpm -r typecheck && pnpm lint && pnpm test`.
   Each Worker under `workers/` is its own project with its own lockfile: run
   its `pnpm test` (and `pnpm test:runtime` for `agent`, `host` and `admin`,
   which run the Worker in workerd with real bindings).
5. **Commit and push to `main`.** Reference the issue: `Closes #N` when the
   commit fully resolves it, otherwise `Refs #N`.

A push to `main` deploys: each Worker's deploy workflow runs its tests first,
so a failing test blocks that deploy.

## Updating the external app starter repositories

`template-standalone` and `template-connected` are generated mirrors of the
canonical starter foundation in `packages/cli/src/lib/starter-foundation.ts`.
Publication now records `releases/starter.json` only after the published-package
matrix, exact-source CI and browser scaffold checks pass. The acceptance gate
compares both published CLI generators against that source revision. Each mirror
pulls this pinned source using its own scheduled `sync-template.yml` workflow;
no cross-repository write credential or consumer app update is involved.

Mirrors track reviewed canonical hashes in `.fas-template/state.json`. The sync
aborts on manual edits, path conflicts, downgrades or a concurrent main push,
preserves extra infrastructure, and applies the deployment dependency-lock policy.
It typechecks, tests and builds before committing directly to main, then explicitly
dispatches CI and compliance for the resulting SHA (token pushes do not trigger
push workflows). Re-run a failed mirror workflow without re-publishing npm.
An acceptance-job failure can similarly be re-run independently.

For intentional manual reconciliation, check out both mirrors on main, build the
accepted platform revision and run `pnpm --filter @freeappstore/cli sync:templates
<standalone-checkout> <connected-checkout>`. Review all differences, refresh only
an outdated lock, and run typecheck/test/build. Initialize a new mirror baseline
with `node scripts/template-release.mjs bootstrap <mirror> <preset>
<accepted-starter.json>` from the accepted platform checkout; this refuses files
that differ from the canonical generator. Install the mirror-only workflow from
`scripts/mirror-sync-workflow.yml` as `.github/workflows/sync-template.yml` and
add `workflow_dispatch` to its existing CI/compliance workflows. These maintenance
files are excluded from MCP-created consumer apps; CLI apps use the canonical
generator directly.

On Windows, run agent integration tests with `pnpm --dir workers/agent test:runtime`.
The launcher gives workerd an isolated directory under `%LOCALAPPDATA%/Temp`
and removes it after the run. A deeply nested inherited `TEMP`/`TMP` (such as a
browser-runner session directory) can make workerd's Durable Object SQLite paths
exceed Windows path limits, producing opaque `internal error; reference = ...`
failures on every session request while `/health` still passes (#354). The
launcher prints the selected directory and forwards Vitest arguments and exit
status. Linux/macOS keep their existing temporary-directory settings.

## Dependabot

Dependabot still opens pull requests, since that's the only way it can offer
updates. Don't merge them. Apply the update directly on `main` instead: run the
package manager for each affected directory so lockfiles match current `main`,
check as above, push, then close the PR with a comment pointing at the commit
and delete its branch. Updates that can't be taken (e.g. a breaking major) are
closed with the reason and, if they'd recur, ignored in `.github/dependabot.yml`.

## Outside contributors

You can't push to `main`, so open an issue describing the change (and a patch
or link to your fork if you have one). A maintainer lands it on `main`.
Security issues go through a private advisory instead (see `SECURITY.md`).
