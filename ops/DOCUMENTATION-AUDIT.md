# Documentation consistency audit — 2026-10-22

Tracking issue: [platform #294](https://github.com/freeappstore-online/platform/issues/294).

## Coverage

FreeAppStore platform monorepo: storefront pages and metadata, generated app-detail copy, ten generated AI-tool guides, published developer docs, SDK/CLI READMEs, console onboarding/help, MCP-served SDK reference, brand guidance, and operating runbooks. Admin help and the current browser-permission reference were searched for the same drift patterns. Historical research and design documents remain separate from live API contracts.

Sister-store links were reviewed as FreeAppStore navigation and comparisons. Their independent repositories, pricing policies, and deployment configurations are outside this repo's implementation. FreeAppStore now links to their own sites instead of copying unverified plans.

## Implementation references

| Topic | Source of truth |
|---|---|
| SDK modules and methods | `packages/sdk/src/index.ts`, individual clients, UI exports |
| CLI commands, flags, first push, game guard | CLI `index.ts`, `commands/init.ts`, `commands/publish.ts` |
| Quotas | Backend `lib/quota.ts`, `routes/db.ts`, `counters.ts`, `secrets.ts`, `email.ts`, `webhooks.ts`, `rooms.ts`, `do/room.ts` |
| Accounts, deletion, storage, diagnostics | Backend auth, keys, analytics, logs, push routes and SDK clients |
| Browser APIs and embedding | Host Worker, storefront iframe generation |
| Hosting and docs publication | Host Worker, storefront `/app` proxy, app workflow generator, platform deploy workflows |
| Backups | Backend `lib/backup.ts`, scheduled handler, tracked cron configuration |

## Findings resolved

- Canonical SDK docs used `fas.db`; the SDK exposes `fas.collections`. MCP examples called collection CRUD on the root instead of a collection handle.
- MCP/AI examples referenced absent room and friendship methods. Contract tests now check those expressions against actual SDK types, including collection and room handles.
- Console help showed `fas create`, omitted dependency installation, and displayed the obsolete room peer cap.
- CLI references advertised an absent `--issue` flag and submission-form fallback. Provisioning actually reports failures and exits. Game templates remain available, but the FAS backend refuses game publishing; games use their separate CLI.
- Quick starts omitted remote setup or pushed to a nonexistent `origin`. Instructions now follow the CLI's printed upstream commands.
- Public guides used the retired console `/create` location, implied a creator approval queue, or guaranteed fixed deployment time. The canonical builder is `/app/build`; provisioning and first deployment are distinct.
- Quotas mixed obsolete claims with enforced limits: fictional KV daily-user/minute caps and dedicated per-app D1 allocation were removed; room behavior, global user-key proxy budget, email sender limit, push schedules, and webhook events were corrected.
- Push docs linked to a limits file excluded from publication. The canonical public limits page now contains the push reference; the old filename is a source-link compatibility pointer.
- About, pricing, capabilities, metadata, and per-app privacy text contradicted accounts, cloud services, analytics configuration, and provider dependencies. Copy now distinguishes device storage, connected services, public collections, external provider costs, and configuration requirements.
- FreeAppStore copied Pro prices and guarantees without a source in this codebase. It now describes FAS and links to Pro's current pricing and docs.
- AI guide generation had stale instructions and disabled browser zoom. The generator and ten outputs were updated together. Codex instructions were verified against [official documentation](https://learn.chatgpt.com/docs/agent-configuration/agents-md).
- Docs used an unrelated green mark/palette. Publication now uses the storefront favicon source and FreeAppStore blue palette.
- Duplicated brand/operating manuals taught retired per-app Pages provisioning and pointed at archived repositories. They now reference maintained guides and current workflow ownership. Recovery docs acknowledge daily best-effort exports and the absence of automated whole-account or cross-account recovery.

## Verification and maintenance

- `packages/sdk/src/platform-docs.test.ts` checks documented SDK members, collection/room methods, accepted webhook examples, CLI publish flag tables, and links to files actually published by the docs workflow.
- Existing SDK docs tests check Shell props, UI imports, navigation examples, relative links, and anchors.
- Build the storefront and the exact docs publication workflow locally; inspect rendered pages and verify live surfaces after deployment.
- Run root, console, storefront, and Worker checks under [CONTRIBUTING.md](../CONTRIBUTING.md).
- When changing behavior, update implementation, canonical reference, relevant website copy, MCP reference, and generated guides together. Do not revive duplicate manuals as independent authorities.

This audit does not certify legal compliance, provider configuration, every app's data practices, or independent sister-store deployments. Privacy changes remove statements contradicted by implemented features; apps and provider integrations still need accurate individual disclosures.
