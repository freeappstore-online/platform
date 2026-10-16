# Contributing

## Where issues belong

| Topic | File issues in |
|---|---|
| App features, bugs, compliance checks, deploy tickets | `freeappstore-online/<app-id>` (the individual app repository) |
| SDK (`packages/`), `fas` CLI, workers / backend, storefront, CI pipelines, platform docs | `freeappstore-online/platform` (this repo) |

**Rule:** once an app repository exists, every issue that is specific to that app lives there.
The only exception is provisioning (creating the app repo itself), which must be filed in platform
because the app repo does not yet exist at that point.

When a coding agent plans tickets for an app epic, it should file those tickets in the app
repository (`gh issue create --repo freeappstore-online/<app-id> …`), not in platform.

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
