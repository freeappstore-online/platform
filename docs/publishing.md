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
4. **Deploy workflow** -- injects `.github/workflows/deploy.yml` locally if missing.
5. **Ownership** -- records the app in the platform DB.
6. **Output** -- prints the launch URL, repo URL, future storefront URL, and `git remote add` + `git push` commands.

If provisioning is unavailable, the command reports the error and exits. Nothing is queued and no submission form opens. Retry after checking the platform status; `--issue` is not a supported flag.

## Deploy flow

After the initial publish, every `git push` to `main` triggers auto-deploy:

1. GitHub Actions runs `.github/workflows/deploy.yml`
2. Builds the app (`pnpm build`)
3. Uploads `web/dist/` to the `fas-apps` R2 bucket under `apps/<app-id>/`
4. The host Worker at `*.freeappstore.online` serves from R2

The URL starts serving your code after a successful first push and deploy. Runtime depends on build time and the Actions queue; use `fas logs <id>` or the console to check it.

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
