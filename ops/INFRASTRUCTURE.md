# FreeAppStore infrastructure

This is the current operating map. Historical per-app Cloudflare Pages instructions do not describe the active app-hosting path.

## Source and deployments

| Surface | Source | Deployment |
|---|---|---|
| Storefront and public guides | `sites/storefront` | `deploy-storefront.yml`: build static output, deploy the `freeappstore` Pages project |
| Official docs | `docs` | `publish-docs.yml`: build with Zensical and ingest into `fas-kb` through kb-host |
| Creator console and VibeCode UI | `sites/console` | `deploy-console.yml`: upload `web/dist` to `fas-apps/apps/console/` |
| Platform API | `packages/backend` | `deploy-backend.yml`: Workers, shared D1, room Durable Objects |
| App hosting | `workers/host` | `deploy-host.yml`: serve R2 bundles through routes stored in D1 |
| Provisioning and moderation | `workers/admin` | `deploy-admin.yml`: privileged admin Worker and its SPA |
| VibeCode execution | `workers/agent` | `deploy-agent.yml`: AI build sessions and app deployment |
| MCP | `workers/mcp` | `deploy-mcp.yml`: scoped build and inspection tools |
| Docs / app knowledge bases | `packages/kb-host` | `deploy-kb-host.yml`: serve the KB bucket |

Workflow files live in [the platform workflow directory](../.github/workflows). Paths, bindings, and identifiers are declared in each project's tracked Wrangler configuration; do not copy account state from an old runbook.

## Runtime paths

- Storefront: `https://freeappstore.online/`.
- Console: `https://freeappstore.online/app/`; VibeCode: `/app/build`. The apex `/app/*` Pages function proxies the console origin and strips the prefix upstream.
- API: `https://api.freeappstore.online`.
- Apps: `https://<id>.freeappstore.online`; host looks up the app's route and serves `apps/<id>/` from `fas-apps`.
- Admin: `https://admin.freeappstore.online`.
- MCP: `https://mcp.freeappstore.online/mcp`.
- Docs / KB: `https://docs.freeappstore.online/` and `https://kb.freeappstore.online/<app>/`.

## App publishing

[Publishing](../docs/publishing.md) is self-service. The backend `/v1/publish` authenticates the creator and calls the privileged admin service. Provisioning creates a public app repository, hosting route, and storefront registry entry. The CLI adds a deployment workflow locally when needed and prints the first remote/push instructions.

A push to the app's `main` builds the app and uploads `web/dist/` to R2 using the app's workflow. There is no Cloudflare Pages project per new app. The platform storefront's Pages deployment is separate from app deployments.

Check the app's workflow, Actions result, R2 prefix, D1 route, and host response when a deploy is missing. A successful provisioning response does not mean app code has already been pushed.

## Data and scheduled work

The API uses shared D1 storage, with app/user scoping enforced by its routes. The room service uses Durable Objects. The API's tracked cron configuration runs uptime checks and push reminders every 15 minutes, log cleanup at 03:00 UTC, D1 JSON export at 04:00 UTC, and weekly audits on Sunday at 06:00 UTC.

The daily export writes `db-backups/<date>/fas.json` to `fas-backups`. It is a best-effort export of the tables selected in `packages/backend/src/lib/backup.ts`, not a whole-account backup or cross-account disaster-recovery system. Verify table coverage when adding schema, and verify actual backup objects after deployment. See [Recovery](DR.md).

## Configuration and secrets

Public app build variables are supplied through GitHub Actions and compiled into browser bundles. Runtime Worker credentials use the project's configured secret-management process. App API secrets and user keys use the platform's encrypted stores. Do not copy credentials into this documentation, public source, logs, or `VITE_*` variables.

## Checks

Follow [CONTRIBUTING.md](../CONTRIBUTING.md). Root workspace checks do not replace each Worker's independent tests and runtime tests. The console and storefront have their own build and test commands. Production probes and live browser tests are defined in `.github/workflows`; consult their latest results rather than assuming a previous green deployment is still current.

Sister stores have separate infrastructure and publishing tools. This runbook describes FreeAppStore; it does not define their plans, prices, quotas, or current deployment model.
