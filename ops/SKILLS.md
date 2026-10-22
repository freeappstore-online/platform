# Platform operating reference

The maintained developer and AI guide is [sites/storefront/SKILLS.md](../sites/storefront/SKILLS.md), published at <https://freeappstore.online/skills.md>. Update that source instead of keeping a second SDK/publishing manual here or editing the archived storefront repository.

## Current layout

- [Architecture](../docs/architecture.md): services, domains, bindings, and data model.
- [Infrastructure](INFRASTRUCTURE.md): deployment ownership and source files.
- [Publishing](../docs/publishing.md): self-service app provisioning and first deployment.
- [Submission and moderation](SUBMISSION.md): current provisioning and operational review.
- [Recovery](DR.md): outage investigation, backups, and recovery limitations.
- [Access](ACCESS.md): repository permissions and identity rules.
- [Platform limits](../docs/platform-limits.md): implemented service quotas.

## Delivery

Follow [AGENTS.md](../AGENTS.md) and [CONTRIBUTING.md](../CONTRIBUTING.md): work directly on `main`, use the correct issue repository, run the required checks, and push. Do not create branches or pull requests. App issues belong on the individual app repository; SDK, CLI, infrastructure, docs, and storefront issues belong on platform.

The storefront deploys to Cloudflare Pages from `sites/storefront`. App bundles and the creator console deploy to R2 and are served by the host Worker. Those are separate deployment paths. The app deployment workflow is committed to each app repository; public build variables are configured in GitHub Actions. Secret API keys belong in the encrypted platform stores, never in browser bundles.

A successful `fas publish` provisions an app; the first code push and deploy make its bundle available. Provisioning errors are reported, not converted into a submission form. Games use the separate FreeGameStore publishing flow.

## Maintaining consistency

Update the implementation, canonical docs, relevant website copy, and MCP `sdk_reference` together. The SDK documentation contract tests check API members, accepted webhook examples, and links to published docs. Regenerate AI guides with `node sites/storefront/ai/generate.js` after editing their generator.
