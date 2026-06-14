# Publishing

How apps get from your local machine to `yourapp.freeappstore.online`.

## Two ways to publish

### Via CLI (recommended for developers)

```bash
fas publish
```

### Via VibeCode (AI builder)

Go to [console.freeappstore.online/create](https://console.freeappstore.online/create), describe your app, and the AI builds + deploys it.

## What `fas publish` does

1. **Compliance gate** -- runs the same checks as `fas check`. Hard failures abort.
2. **Auth check** -- confirms a valid session token (re-login if expired).
3. **Provision** -- POSTs to the platform API, which calls the admin Worker via service binding. Admin creates:
   - An empty GitHub repo in the `freeappstore-online` org
   - A D1 hosting route (subdomain -> R2 prefix)
   - A storefront registry entry
4. **Deploy workflow** -- injects `.github/workflows/deploy.yml` locally if missing.
5. **Ownership** -- records the app in the platform DB.
6. **Output** -- prints the live URL, repo URL, storefront URL, and `git remote add` + `git push` commands.

If the API is unavailable (503), publish falls back to opening a prefilled GitHub Issue form. Use `--issue` to force this path.

## Deploy flow

After the initial publish, every `git push` to `main` triggers auto-deploy:

1. GitHub Actions runs `.github/workflows/deploy.yml`
2. Builds the app (`pnpm build`)
3. Uploads `web/dist/` to the `fas-apps` R2 bucket under `apps/<app-id>/`
4. The host Worker at `*.freeappstore.online` serves from R2

Deploys take ~30 seconds.

## Storefront listing

Your app appears on [freeappstore.online](https://freeappstore.online) with:

- Phone-frame preview
- App name, category, and one-liner
- Recent commits log
- VCQA quality score badge
- Direct link to `yourapp.freeappstore.online`

## Requirements

All published apps must:

- Be open source (MIT license)
- Pass `fas check` compliance (no tracking, brand fonts, valid manifest, <300KB bundle)
- Have a valid `package.json` with a unique name

## Managing your app

After publishing:

- **Console** -- [console.freeappstore.online](https://console.freeappstore.online) for roles, secrets, webhooks, logs, deploys
- **Updates** -- `git push` to auto-deploy
- **Secrets** -- `fas secret set` to add API keys
- **Quality** -- `fas quality` to check your VCQA score
