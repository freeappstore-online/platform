# Composable starter contract

This page describes the shipped starter architecture and the boundaries between platform infrastructure and app-owned product code. For commands and the tested release baseline, see [Starter release and adoption](starter-release.md). It does not authorize automatic migrations of existing apps.

The SDK `Shell` is the supported default, not a required product layout. Apps may keep it, compose it, or own a custom frame while preserving the user-facing requirements below.

## One canonical foundation

Standalone and connected starters are presets generated from `packages/cli/src/lib/starter-foundation.ts`. The CLI calls `getTemplateFiles` from `packages/cli/src/commands/init.ts`; `workers/agent/src/template.ts` imports that same generator for the builder and adds the selected archetype. `fas init` writes its generated files directly. The external standalone and connected template repositories are release mirrors of the canonical output. The game templates retain their separate clone path.

Builder capability changes use the `install_capabilities` chat tool and the session capabilities API. CLI users use the same bundled, first-party definitions through `fas add`. Capabilities are versioned files and package prerequisites, recorded in `.fas-capabilities.json`; there is no marketplace, downloaded install script, or arbitrary package installer.

| Starter | Default data/auth behavior | Generated product example |
| --- | --- | --- |
| `standalone` | No sign-in gate; device-local app | Public Home and About screens |
| `connected` | Auth is available, but public screens stay public; private draft data is gated at its feature boundary | Public Home/About and a signed-in private draft |

`connected` does not make every screen private. The Profile route remains reachable while signed out. Game templates are separate from these app presets.

## Ownership and safe changes

The platform owns versioned infrastructure: the SDK client and auth lifecycle, storage and room APIs, the default `Shell` and `ProfilePage`, generated capability helpers, PWA runtime/config helpers, and the CLI/builder capability resolver.

The app owns its editable product code: screens, navigation and route handling, domain models, workflows, content, and any custom frame. Authors may replace a generated example while retaining the platform infrastructure they need. A custom layout is a supported choice, including sidebars, bottom navigation, and focused canvas views.

Install and update operations are idempotent and support dry runs. They report conflicts instead of overwriting edited generated files, replacing app configuration silently, or deleting app data. A generated-content change advances its capability version; existing tracked versions require an explicit `--update` after preview. Review a conflict and resolve it in the app's repository; there is no force-overwrite switch. Keep version control backups before applying an update. Removing an import or generated helper is an app-owned edit; the installer does not provide an automatic removal or data-migration command.

The generated router is app-owned. An SDK update does not rewrite existing `App.tsx` routing. If an app needs the query/hash Profile-return fix, review its route handlers and preserve the full URL in history while deriving screen state from the browser's resulting pathname:

```ts
window.history.pushState(null, "", href);
setPath(window.location.pathname);
```

Adapt this narrowly to the app's router; keep query parameters and fragments in the history URL. Do not apply an automatic rewrite across existing apps.

## User-facing requirements

The following are behavior requirements, not layout or markup templates:

- Keep public content reachable without signing in. Gate only features that require a particular account or data permission.
- Provide a reachable Profile/account path in signed-out and signed-in states. The generated compact avatar opens Profile and does not itself start OAuth. Appearance preferences are available from Profile in both auth states and persist across the app's controls.
- Preserve keyboard operation, visible focus, meaningful labels, loading/error feedback, and a way to skip repeated navigation. Keep interactive targets usable (the default Shell uses 44px targets). Keep browser page zoom enabled; do not set `user-scalable=no` or a `maximum-scale` restriction. Support enlarged text and narrow screens.
- Keep the generated MIT license notice when distributing substantial portions of the starter. Store attribution is optional; apps do not have to add a footer or store mark.
- Do not add payments, ads, direct tracking, secrets in client code, or credentials in `VITE_*` values. Ensure `initApp` uses the deployed app id. Do not describe public data as private.
- React app styling follows [ADR-001](https://github.com/freeappstore-online/platform/blob/main/docs/adr/001-tailwind-on-fas-tokens.md), including custom frames. This does not prescribe a component tree, exact navigation markup, typography, or screen composition.

## PWA, offline behavior, and data boundaries

The PWA capability ships with the starter. The shared runtime prompts before activating an update; app-owned busy guards can defer activation/reload while edits, recording, or other declared work is active. Keep one controller and remove guards when their work ends. The generated PWA setup caches the application shell and build assets. A cached shell does not imply that a network feature, media source, or remote model works offline. Describe save/sync state accurately and surface failed local writes as failures.

| Data class | API or mechanism | Actual access and durability |
| --- | --- | --- |
| Device-local | `@freeappstore/sdk/persist` (localStorage/IndexedDB helpers) | Stored on this origin and device; does not sync or constitute a backup. A failed write is not a successful save. |
| Private account | `fas.kv` | Per-user keys for this app; requires a signed-in account. Clear/hide account data when the session changes and ignore stale responses. |
| Public shared | `fas.collections` | Public read, owner write. UI filtering or an owner query does not make documents private. |
| Durable room data | Authenticated data-room endpoints | Explicit room members have equal CRUD access to room documents. Members can read, change, and delete shared votes or records; membership does not hide one member's values from another. |
| Realtime room | `fas.rooms` | Ephemeral WebSocket broadcast, not durable storage, an access-control list, or a private room. |

Choose a data class deliberately. Do not put private values or hidden votes in public collections or realtime broadcasts. Device-local backups are explicit user-managed files: validation/checksum checks complete before writes, then the SDK calls the app's apply callback with an explicit merge or replace choice. If apply fails, the SDK attempts the app-supplied snapshot restore. A successful restore is reported as a failed import with the prior data restored. If restore also fails, the result is `{ ok: false, reason: 'rollback' }` and stored data may be partial; surface that failure without claiming success or intact old bytes. Capability installation and PWA updates do not migrate or delete existing records.

## Builder and CLI adoption

The builder exposes first-party capability installation through the `install_capabilities` chat tool and `POST /session/:id/capabilities`. Preview with `dryRun: true`, review package prerequisites and file conflicts, then apply the reviewed plan. The CLI provides the corresponding `fas add <capability> --dry-run` and apply flow. Capability-owned files/configuration and their declared dependencies may change; app-owned edits remain protected. See [Starter release and adoption](starter-release.md) for recipes, package minimums, verification evidence, and known limits.

## Scope boundaries

This contract governs the canonical generated foundation and its adoption guidance. It does not migrate existing app repositories, update sibling stores, or claim that every published app has adopted the starter. App-specific product work belongs in that app's repository. Styling checks and security, accessibility, license, and data-integrity requirements remain independently enforced.

#318 and [ADR-001](https://github.com/freeappstore-online/platform/blob/main/docs/adr/001-tailwind-on-fas-tokens.md) remain the governing styling work, and #327 remains the shared design-system specification. This release does not restart #326, change warn-only styling checks to fail, or edit sibling stores.
