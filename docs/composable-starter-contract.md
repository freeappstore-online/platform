# Composable starter contract

Accepted for epic #342 by issue #343. This page is the architecture and ownership contract. It does not add APIs, merge templates, migrate apps, or change check severity.

The supported way to start an app stays the SDK `Shell` described in [Getting Started](getting-started.md#build-your-app-on-the-shell) and [UI Components](ui.md#shell-the-standard-app-frame). Product layout is not a platform requirement.

## What already exists

Reuse this machinery. Do not replace it with a plugin host.

| Piece | Where it lives | What it already does |
| --- | --- | --- |
| App archetypes (#18) | `workers/agent/src/template.ts` (`dashboard`, `tracker`, `calculator`, `generic`) | Prompt seeds on the shared app scaffold. Not separate products. |
| Build sanity (#10) | `workers/agent/src/build-sanity.ts` | Blocks duplicate top-level declarations and a second `export default` before deploy. |
| Delta deploy (#13) | `workers/agent` deploy path | Pushes the agent delta over the provisioned scaffold so platform files survive. |
| CLI scaffolds | `packages/cli/src/commands/init.ts`, `packages/cli/src/lib/starter-foundation.ts` | `fas init` generates standalone and connected apps from the shared foundation. External template repositories are release mirrors; game templates keep their separate clone path. |
| Builder scaffold | `workers/agent/src/template.ts` `getTemplateFiles` | Consumes the same worker-safe generator as the CLI, then adds archetype files. |
| Shell account (#337–#340) | `packages/sdk/src/ui/layout.tsx`, `profile.tsx` | Compact avatar opens `ProfilePage` in both auth states. `profileHref` is the app-owned route. Preferences and auth lifecycle are shared. |
| Styling (#320, ADR-001) | [ADR-001](https://github.com/freeappstore-online/platform/blob/main/docs/adr/001-tailwind-on-fas-tokens.md) | React + Tailwind 4 on FAS tokens for every React surface, including apps, the SDK, console, and admin. |

`fas add`, a capability manifest and the shared generated foundation now ship. Use the safe adoption workflow below.

## Foundation, capabilities, and presets

One foundation: the PWA toolchain, SDK runtime, design tokens, and the default `Shell`. Standalone and connected are presets, not two maintained implementations. The CLI and builder use `packages/cli/src/lib/starter-foundation.ts`; `fas init --template standalone|connected` selects the preset, and the external template repositories are updated from that source with `sync:templates`.

A capability is a versioned, first-party unit a preset can include at `fas init` or later with `fas add` ([#345](https://github.com/freeappstore-online/platform/issues/345)). It declares an id, a version, dependencies, the environment it supports, the files and config it owns, and how to validate it. Presets are lists of those ids. There is no plugin marketplace and no remote script execution.

Ship these presets:

| Preset | Means | Today |
| --- | --- | --- |
| `standalone` | Device-local data. No sign-in gate. | Home and About inside `Shell`. |
| `connected` | Platform account services (auth, KV, and the others the preset lists). | Public Home/About plus an app-owned private draft that gates only its own data. Profile remains reachable signed out. |

Game templates are not FAS presets.

## Ownership

Runtime and packages own versioned infrastructure:

- SDK client, auth, KV, collections, rooms, proxy, and the default `Shell` / `ProfilePage`
- compliance checks and the CLI resolver that will install capabilities
- the PWA update runtime and its app-owned busy guards ([#346](https://github.com/freeappstore-online/platform/issues/346))

Fresh Shell starters use SDK `^0.16.32` for the verified compact header and Profile appearance controls. Optional capabilities retain their independent API minimums (for example, PWA remains `>=0.16.15`).

The app owns generated product code after the author edits it:

- screens, navigation structure, domain models, and workflows
- a custom frame, when the app chooses one
- user data and app-chosen backup files

Install and update must be idempotent, support a dry-run, and refuse to overwrite an edited generated file or delete user data. Conflict detection reports the file. It does not guess.

## Defaults and requirements

Supported defaults (replaceable):

- `Shell` as the frame: app name, text size, theme, compact avatar, primary navigation in the topbar, error boundary, toasts, offline banner, skip link
- one `nav` entry per primary screen, rendered as `<nav aria-label="Main">`
- `PageHeader` as the primary screen's single `h1`
- React + Vite, with the token styling rule below

A custom frame, sidebar, bottom nav, or detail route is allowed. A detail route does not need its own `nav` item. `renderNav` and `NavBar` remain for apps that keep `Shell` and replace only the navbar.

These stay requirements:

| Contract | Rule |
| --- | --- |
| Accessibility | Labelled navigation, keyboard use, visible focus, a skip link or equivalent, and page zoom. The default Shell keeps 44px targets. Do not set `user-scalable=no` or `maximum-scale` on the document. A canvas may call `preventDefault` on its own element. |
| Platform identity | No payments, ads, or tracking. No upgrade or subscription screen. The default topbar shows the app name only. Store attribution is the opt-in `Footer`, and `Shell` never mounts it. |
| Security | No secrets in client code or `VITE_*` values. The `initApp` id must be the deployed app id ([#344](https://github.com/freeappstore-online/platform/issues/344)). Public data must not be described as private. |
| Styling | [ADR-001](https://github.com/freeappstore-online/platform/blob/main/docs/adr/001-tailwind-on-fas-tokens.md) still applies to React UI, including a custom frame. Platform-owned UI (SDK, console, admin) does not get a second styling system. |

`requireAuth` gates app content only. The frame and the profile route stay reachable.

## Account, attribution, zoom, updates, and data

Account behaviour shipped in #337–#340:

- The topbar shows `appName` only. It does not show a store logo.
- The avatar is a compact link (24px signed out, 32px signed in, 44px hit target) to the profile route in both auth states. It does not start OAuth and does not open a dropdown.
- With no `profileHref`, `/profile` renders `ProfilePage`. Signed out, that page shows GitHub and Google `SignInButton`s. Signed in, it shows account and preference actions.
- `profileHref` selects an app-owned route. That route must render both auth states.
- The theme toggle is in the topbar while signed out, and on `ProfilePage` while signed in. Text size and theme stay shared across those controls (#340).
- `SignInButton` and `ProfileMenu` stay exported. `Shell` does not mount them. `ProfileMenu` is the legacy dropdown. New guidance must not tell agents to put either in the header.
- `Footer` is optional installed-mode attribution. Its default label, when an app imports it, is "Part of FreeAppStore".

Zoom, safe update, and honest offline are specified here and implemented in #346. This issue does not change service workers.

- Installability, useful offline behaviour, and update activation are three contracts.
- A cached shell does not mean cloud, media, or model features work offline.
- The target update behaviour is a prompt. Activation and reload wait while the app has unsaved edits, an active recording, or another declared busy guard.
- Several surfaces still set vite-plugin-pwa `registerType: 'autoUpdate'`. That is not the target, and `registerType` alone is not a promise that every tab reloads. #346 replaces it and covers the upgrade.

Data access, as the API behaves today. #350 adds race-safe examples. It must not invent a privacy flag the server does not enforce.

| Class | Mechanism | Meaning |
| --- | --- | --- |
| Device-local | `localStorage` or IndexedDB | This origin on this device. A failed write must surface (#348, following the #341 pattern of catching storage failures). Not a backup. |
| Private-account | `fas.kv` | The signed-in user's keys for this app. |
| Public-shared | `fas.collections` | Public read. Owner writes. Hiding a value in the UI is not confidentiality. |
| Room fan-out | `fas.rooms` | Ephemeral broadcast. Not an access-control list and not a private room. |

Capability install and PWA update must not delete those records.

## Styling epic #318, fleet migration #326, and #327

#318 remains the styling epic: one React + Tailwind 4 on FAS tokens model. ADR-001 (#320) is the accepted decision. This contract does not reopen it and does not weaken that rule.

#327 remains the shared design-system spec (opaque `--panel`, opt-in glass, `--popover`). That file is shared with other stores. This issue does not edit it and does not change sibling stores.

#326 is the fleet migration that would move every app onto that styling model and then flip styling checks to fail. It stays where it is. This issue does not migrate apps, does not write to app repositories, and does not change `css-discipline`, `opaque-surface`, or the related styling checks from warn to fail.

Hard checks stay on security, the deployed artifact, accessibility, and data integrity. Layout choice is not one of them.

## Plan for the remaining children

Each child is a small addition to the files below. None of them introduces a generic plugin framework. Do not start a child until its predecessor is actually on `main`.

| Order | Issue | Add | Reuse |
| --- | --- | --- | --- |
| 2 | [#344](https://github.com/freeappstore-online/platform/issues/344) | Compliance check plus doctor output for the declared app id, package root, build command, and uploaded artifact. Fixtures for an excluded second app and a leftover `my-app` id. | `workers/agent/src/build-sanity.ts`, `packages/cli/src/one-shot/doctor.ts`, `packages/cli/src/commands/check.ts`, `packages/compliance/src/checks/`. Do not fail a repo only because it has several packages. |
| 3 | [#345](https://github.com/freeappstore-online/platform/issues/345) | `packages/cli/src/lib/capabilities.ts`, `packages/cli/src/commands/add.ts`, and a `fas.capabilities.json` manifest. `fas init` and `fas add` share one resolver. Dry-run, idempotent reinstall, and a conflict when a generated file was edited. | Presets are capability id lists. First-party registry only. |
| 4 | [#346](https://github.com/freeappstore-online/platform/issues/346) | One PWA capability: manifest, icons, install, offline truth, zoom, and a prompted update with a busy guard. | The manifest and viewport checks in `packages/compliance`. Replace copied `registerType: 'autoUpdate'` blocks. Do not cache authenticated responses. |
| 5 | [#347](https://github.com/freeappstore-online/platform/issues/347) | Composable frame, account, and routing primitives so apps stop patching Shell DOM. Guidance: [Migrating from DOM overrides](ui.md#migrating-from-dom-overrides). | `packages/sdk/src/ui/layout.tsx` and `profile.tsx` (`headerActions`, `renderNav`, `profileHref`, `AccountSection`, `ProfilePage`). |
| 6 | [#348](https://github.com/freeappstore-online/platform/issues/348) | Typed local persistence with an explicit save failure. | The storage-failure handling added for the logger in #341. App data must not pretend a failed write succeeded. |
| 7 | [#349](https://github.com/freeappstore-online/platform/issues/349) | Validated backup/import and a browser file export on the #348 helper. | No new backend. |
| 8 | [#350](https://github.com/freeappstore-online/platform/issues/350) | Connected examples for the four data classes, including a race-safe KV update. | `docs/sdk.md` and `fas.kv` / `fas.collections` / `fas.rooms`. Do not add a private-room mode the API does not enforce. |
| 9 | [#351](https://github.com/freeappstore-online/platform/issues/351) | Optional realtime and media recipes with close, permission, and busy-update checks. | `fas.rooms`. Custom signaling stays app-owned. |
| 10 | [#352](https://github.com/freeappstore-online/platform/issues/352) | Generate standalone and connected presets from the shared foundation and keep external template mirrors current. | `packages/cli/src/lib/starter-foundation.ts`, `packages/cli/src/commands/init.ts`, `workers/agent/src/template.ts`, and builder capability entrypoint. #18 archetypes stay seeds. |
| 11 | [#353](https://github.com/freeappstore-online/platform/issues/353) | Fresh-scaffold and published-package evidence, plus adoption notes. | No fleet rewrite and no sibling-store edits. |

## Out of scope

App-specific bugs stay in each app repository. This contract does not restart #326, does not edit sibling stores, and does not flip warn-only styling checks to fail.

## Builder adoption guidance

The effective app builder prompt follows this contract: Shell is the supported default, and app-owned screens, navigation, styles and edited configuration remain editable. Custom frames must preserve labelled navigation, keyboard access, visible focus, a skip link or equivalent, zoom, 44px targets, account/profile access in both auth states, shared preferences and error/loading feedback.

Choose device-local helpers from `@freeappstore/sdk/persist` with validation and explicit save-result handling, private-account `fas.kv`, public-read/owner-write `fas.collections`, or ephemeral `fas.rooms` according to requirements. Device-local data is not a backup; collections and room fan-out are not private storage. See [persistence and connected examples](sdk.md). Keep public screens reachable, share the app-owned SDK instance and guard against stale account responses. A cached shell does not make network features work offline.

Builder infrastructure remains locked to direct `write_file` calls. Install first-party capabilities through `POST /session/:id/capabilities` with `dryRun: true`, review prerequisites/conflicts, then apply; local adopters use `fas add --dry-run` before applying. Capability-owned dependencies/configuration may change through that workflow. Preserve edited generated files and user data; do not bypass locks or install arbitrary dependencies. Chat tools without access to the session API must describe the required action without claiming it ran.
