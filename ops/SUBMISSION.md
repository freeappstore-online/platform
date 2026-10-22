# App publishing and operational review

## Standard flow

App publishing is self-service, not a 48-hour creator application queue.

1. The creator signs in with `fas login`, scaffolds with `fas init`, and builds locally.
2. `fas check` validates compliance; `fas publish` also runs the checks unless explicitly skipped.
3. The CLI calls the backend `/v1/publish`. The backend validates the request and ownership and delegates privileged provisioning to the admin Worker.
4. Provisioning creates the app repository, R2 hosting route, and storefront registry entry.
5. The CLI writes the app deployment workflow locally if needed and prints remote and push commands. The creator pushes the code; GitHub Actions builds and uploads it to R2.

The console and VibeCode provide browser workflows. AI builds require a usable provider connection or a vaulted key. The current CLI reports provisioning failures and exits; it does not open an issue form or queue a submission. `--issue` is not a supported publishing flag.

## Sources of truth

- [Developer publishing guide](../docs/publishing.md).
- `packages/cli/src/commands/publish.ts`: CLI behavior and first-push instructions.
- `packages/backend/src/routes/publish.ts`: authentication, request validation, store separation, ownership.
- `workers/admin/src/routes/provision.ts`: privileged provisioning.
- `workers/admin/src/routes/deprovision.ts`: explicit resource teardown.
- `sites/storefront/registry.json`: storefront listings.
- `workers/host/src/host.ts`: runtime routing and app headers.

## Operational review

Public app source must be MIT licensed and pass the current compliance rules. Permissions shown on listings come from declarations and source scans, not a claim that an app sends no data. Examine app source, deployment logs, quality results, reports, and actual behavior when investigating a complaint.

Use the existing admin workflows for moderation and resource lifecycle actions. Delisting, disabling a route, and deleting repositories or storage are distinct operations; follow the relevant implementation and preserve evidence. Do not use the retired manual recipe for creating a Cloudflare Pages project per app.

## Issue placement

App bugs, features, compliance, and deployment work belong on `freeappstore-online/<app-id>`. Provision the app first if its repository does not yet exist; only a pre-provisioning ticket can live on platform. SDK, CLI, hosting, storefront, CI, and documentation issues belong on platform. See [CONTRIBUTING.md](../CONTRIBUTING.md).

## Updating an app

Push reviewed changes directly to the app's `main` under its repository instructions. The generated workflow handles deployment. For ownership transfers, use `fas admin transfer-owner` with the recorded current owner and a reason; see [CLI Reference](../docs/cli.md#fas-admin-transfer-owner-app).
