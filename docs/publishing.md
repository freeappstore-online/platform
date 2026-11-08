# Publishing

How apps get from your local machine to `yourapp.freeappstore.online`.

## Two ways to publish

### Via CLI (recommended for developers)

```bash
fas publish
```

### Via VibeCode (AI builder)

Go to [freeappstore.online/app/build](https://freeappstore.online/app/build), describe your app, and the AI builds + deploys it.

## What `fas publish` does

1. **Auth check** -- confirms a cached session and rejects expired sessions (re-login if needed).
2. **Compliance gate** -- runs the same checks as `fas check`. Hard failures abort.
3. **Provision** -- POSTs to the platform API, which calls the admin Worker via service binding. Admin creates:
   - An empty GitHub repo in the `freeappstore-online` org
   - A D1 hosting route (subdomain -> R2 prefix)
   - A pending storefront registry entry (kept out of public discovery until deployment)
4. **Deploy workflow** -- injects `.github/workflows/deploy.yml` locally if missing and commits it, so the push carries it. A workflow that reads `secrets.R2_*` or lacks `id-token: write` stops the command before anything is provisioned; rerun with `--update-workflow` to replace it.
5. **Ownership** -- records the app in the platform DB. The server always records `apps.repo` as `https://github.com/freeappstore-online/<app-id>`; any `repo` a client sends to `/v1/publish` is ignored, and re-publishing repairs a wrong value. The keyless deploy accepts only that repository.
6. **Output** -- prints the launch URL, repo URL, future storefront URL, and `git remote add` + `git push` commands. The new repo is empty: the app is not live until you push. `/v1/publish` returns `repoEmpty: true` while the repo has no commits, and the console and admin forms say so.

If provisioning is unavailable, the command reports the error and exits. Nothing is queued and no submission form opens. Retry after checking the platform status; `--issue` is not a supported flag.

## Deploy flow

After the initial publish, every `git push` to `main` triggers auto-deploy:

1. GitHub Actions runs `.github/workflows/deploy.yml`, which only calls the platform's
   [`app-deploy.yml`](../.github/workflows/app-deploy.yml) at a pinned commit (#559)
2. Its `build` job installs, tests and builds the app (`fas.json`'s `buildCommand`) and runs
   the pinned validators, with no credential
3. Its `deploy` job uploads that exact artifact through `api.freeappstore.online` with a
   GitHub OIDC token, under `apps/<app-id>/` in the `fas-apps` R2 bucket
4. The host Worker at `*.freeappstore.online` serves from R2

The API accepts an upload only from `app-deploy.yml` at a commit it lists, started by the
repo's own `deploy.yml` on `main`, so the steps are the platform's: edit `deploy.yml`'s
`with:` to add repo-specific steps (`setup`, `checks`, `python-version`, `code-health`), or
put other checks in a separate workflow file. Every `VITE_*` repository variable reaches the
build automatically. Changing the platform workflow: regenerate it from `appDeployWorkflow()`,
commit, add the commit to `APP_DEPLOY_WORKFLOW_SHAS` in `packages/backend/src/routes/deploy.ts`,
deploy the API, then bump `APP_DEPLOY_WORKFLOW` in the CLI and roll the fleet with
`scripts/fleet-deploy-workflow.mjs`.

The URL starts serving your code after a successful first push and deploy. Runtime depends on build time and the Actions queue; use `fas logs <id>` or the console to check it.

## Unpublishing

`POST /v1/unpublish` (the app's owner or an admin) removes the registry entry, the hosting route, the R2 objects, the DNS record, the `apps` row and the keyless-deploy repository pin. What it leaves behind:

- **The GitHub repo is archived**, not deleted (reversible; read-only, so its deploy workflow no longer runs on pushes it can no longer receive). The response carries an `archive_repo` step. Pass `deleteRepo: true` to delete the repo instead.
- Publishing the same id again by its owner **unarchives** the repo and provisions it again.
- Leaked `e2e-canary-*` apps from a crashed production e2e run are reaped by `scripts/e2e-canary-reaper.mjs`, which the e2e script runs when `FAS_E2E_REAP=1` is set.

## Storefront listing

Provisioning creates the repo and route early so a failed first build can be retried by pushing corrected code. A new listing starts with `discoveryStatus: pending`; it is absent from the homepage, search, public registry, sitemap and cached detail routes while pending.

The automated **Reconcile pending app discovery** workflow runs every ten minutes and can also be run manually. It promotes a pending entry only when its latest main production deploy succeeded for the current main commit and the current launch URL serves healthy HTML without an explicit noindex directive or conflicting canonical. The host's fallback metadata is added after publication, so missing fallback metadata does not block the first listing. Promotion requests the existing storefront deployment; publication timing also depends on the Actions queue and storefront build.

Existing legacy/live entries retain their publication state and are never delisted for a temporary outage. Reprovisioning preserves existing publication choices. Removed, unavailable or private entries are not automatically republished; concurrent edits to the launch target or provisioning generation are rechecked before promotion.

The homepage lists app names, categories, permissions, and quality badges. Selecting an app on desktop opens a live preview. Its detail page adds:

- Phone-frame preview
- App name, category, and one-liner
- Recent commits log
- VCQA quality score badge
- Direct link to `yourapp.freeappstore.online`

## Cross-origin isolation

Off by default. To enable `SharedArrayBuffer` and threaded WebAssembly, add
`"crossOriginIsolated": true` to `fas.json` at the repo root and run `fas publish`.
The host then sends COOP/COEP for your app only. Third-party images and embeds
need CORS or CORP, and popups lose `window.opener`. See
[Browser Capabilities](capabilities.md#cross-origin-isolation).

## Requirements

All published apps must:

- Be open source (MIT license)
- Pass `fas check` compliance (no tracking, brand fonts, valid manifest, initial-load JS <300KB gzipped)
- Have a valid `package.json` with a unique name

## Managing your app

After publishing:

- **Console** -- [freeappstore.online/app](https://freeappstore.online/app/) for roles, secrets, webhooks, logs, deploys
- **Updates** -- `git push` to auto-deploy
- **Secrets** -- `fas secret set` to add API keys
- **Quality** -- `fas quality` to check your VCQA score
