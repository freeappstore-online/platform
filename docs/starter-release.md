# Starter release and adoption

Use this page to create a new FreeAppStore app or add a first-party capability to an app you already own. The completed #353 release is `@freeappstore/cli 0.4.63` with `@freeappstore/sdk 0.16.33`, published from platform source [`13baee6`](https://github.com/freeappstore-online/platform/commit/13baee6b024e69bbc2c21e1714803de51aa87316). The CLI and builder generate standalone and connected apps from the shared platform foundation; the external template repositories are release mirrors.

## Start a new app

```sh
fas init my-app --template standalone
# or
fas init my-app --template connected

cd my-app
pnpm install
pnpm dev
```

Both starters include the PWA capability. Standalone has no sign-in gate. Connected keeps Home/About public and gates only its private draft feature. `fas init` creates editable app screens, a working package setup, and `.fas-capabilities.json`.

To include optional capabilities at creation, pass IDs with `--capabilities`:

```sh
fas init field-notes --template standalone --capabilities persistence,backup
```

Capability IDs are `connectivity`, `pwa`, `persistence`, `backup`, `realtime`, `media`, and `cloud-data`. `cloud-data` adds reference guidance; it does not install a private-room service. `backup` depends on `persistence`. Preset/template names and capability IDs are separate: `--template connected` selects the app starter; `--preset backup` selects the bundled optional-capability list.

## Add or update later

Inspect an addition before it writes files or package metadata, then apply the reviewed plan:

```sh
fas add persistence backup --dry-run
fas add persistence backup
```

For a tracked capability version update, first preview with the explicit update option:

```sh
fas add persistence --update --dry-run
fas add persistence --update
```

The #353 backup guidance correction advances the bundled `backup` recipe from
`1.0.0` to `1.0.1`. Existing tracked `1.0.0` installs must review
`fas add backup --update --dry-run` and then apply with `--update`; edited owned
files remain conflicts. The version records changed generated guidance and does
not change the SDK backup data format or delete saved records.

An edited owned file or incompatible prerequisite is a conflict. Commit or back up your work, inspect the plan, and resolve the conflict in your app. There is no force-overwrite or automatic removal command. If you stop using a helper, remove its import and then remove the generated files yourself after reviewing references; installation and updates do not delete user data.

In the builder, ask it to install the capability and use its `install_capabilities` tool. It previews the plan with `dryRun: true`; review prerequisites and conflicts before applying. The session API is `POST /session/:id/capabilities`. Capability installation may update only its declared generated files and prerequisites; app screens and other edited files remain app-owned.

## Capability support and package prerequisites

These are the registry's declared API minimums. Fresh Shell starters have a separate `@freeappstore/sdk ^0.16.32` baseline. The CLI preflights package requirements at the package location listed below; it does not silently upgrade an existing app's dependencies.

| Capability | What it provides | Prerequisite |
| --- | --- | --- |
| `pwa` | Manifest/icons, PWA config helper, service-worker controller, shell-only offline behavior and prompted updates | `@freeappstore/sdk >=0.16.15` and `vite-plugin-pwa ^1.0.0` in `web` |
| `connectivity` | Browser online/offline hints with an unsubscribe function | Browser APIs; no SDK package |
| `persistence` | Device-local preference, record, transaction and file helpers | `@freeappstore/sdk >=0.16.18` at the app root |
| `backup` | Validated export and explicit merge/replace import; depends on `persistence` | `@freeappstore/sdk >=0.16.21` at the app root |
| `realtime` | Cleanup-bound adapter for ephemeral `fas.rooms` messages | `@freeappstore/sdk >=0.16.26` at the app root |
| `media` | User-triggered browser capture, recorder/track cleanup and share/download export | `@freeappstore/sdk >=0.16.26` at the app root; secure context and browser permission/support |
| `cloud-data` | Reference guide for choosing an existing data model | No package; it adds documentation only |

Import scope matters. PWA modules run from the `web` package; persistence, backup, realtime and media examples are app-root modules. A custom dependency layout can fail preflight even if an SDK package exists somewhere else in the workspace. Resolve that prerequisite explicitly rather than bypassing the check.

## Keep product code and infrastructure separate

Treat generated screens and routing as your app's code. You can redesign them, use a custom frame, move navigation, or replace the starter example. There is no required screen markup, exact layout, topbar, avatar size, or attribution footer. Keep usable account/Profile access in both authentication states when your app uses accounts, provide keyboard and focus access, preserve page zoom and enlarged-text behavior, and keep generated MIT license terms with substantial copied starter code.

This release implements starter composition and adoption. Styling remains governed by #318 / ADR001 and #327; it does not restart #326, change warn-only styling checks to fail, or edit sibling stores.

Platform infrastructure includes the SDK runtime, Profile preferences/auth behavior, PWA runtime, and capability-owned helpers. Keep one PWA controller and register/remove busy guards around unsaved work, active recording, or other operations that must finish before reload. Updates wait for the user prompt and honor those guards. Offline caches the app shell and build assets; network-backed data and remote services still require their services. Do not claim that a cached shell makes all app features available offline.

The generated route handlers are app-owned. Updating the SDK will not fix routing in an already generated app. If query/hash navigation returns to the wrong screen, review the router and preserve the complete URL in `pushState` while matching the resulting pathname:

```ts
window.history.pushState(null, "", href);
setPath(window.location.pathname);
```

This keeps query parameters and fragments in browser history while route selection uses the current pathname. Apply this only after reviewing custom routing; no app-wide rewrite is performed.

## Choose data by access and durability

| Need | Use | Limits to communicate |
| --- | --- | --- |
| This device and origin only | `@freeappstore/sdk/persist` | No sync or backup. Surface a failed write as unsaved. |
| A signed-in user's private values | `fas.kv` | Private per account for this app; sign-out/account switch must clear account-scoped UI and stale responses. |
| Public shared data | `fas.collections` | Public read and owner write. A query filter or hidden UI is not privacy. |
| Durable shared room records | Authenticated data-room endpoints | Owners and members have equal CRUD access to room documents. Members can see and change every room record; votes are not hidden from other members. |
| Ephemeral realtime messages | `fas.rooms` | Broadcast only; not durable storage or a privacy/access-control boundary. |

For device-local backup, validate and preview the incoming data before writes and require an explicit merge or replace choice. The SDK calls the app's apply callback, then attempts the app-supplied snapshot restore if apply fails. If restore succeeds, the result reports a failed import with the previous data restored. If restore fails, the result is `{ ok: false, reason: 'rollback' }` and stored data may be partial. Surface that failure and offer recovery; do not report success or claim the previous bytes are intact. Backups are user-managed files, not account sync or cloud backup. For connected requests, use one SDK/auth instance, gate private data at its boundary, and ignore responses that arrive after the active account changes.

## Verified release and representative outcomes

The completed release publishes CLI `0.4.63` and SDK `0.16.33` from platform source [`13baee6`](https://github.com/freeappstore-online/platform/commit/13baee6b024e69bbc2c21e1714803de51aa87316). Every exact-source workflow passed: [CI](https://github.com/freeappstore-online/platform/actions/runs/41902828517), [Quality](https://github.com/freeappstore-online/platform/actions/runs/41902828671), [Docs](https://github.com/freeappstore-online/platform/actions/runs/41902828510), [npm publication and four-case capability matrix](https://github.com/freeappstore-online/platform/actions/runs/41902828500), [Scaffold](https://github.com/freeappstore-online/platform/actions/runs/41902828419), [live E2E](https://github.com/freeappstore-online/platform/actions/runs/41902828412), and [Deploy agent](https://github.com/freeappstore-online/platform/actions/runs/41902828375).

The published CLI `0.4.63` was independently checked for migration from the prior published CLI `0.4.62`: backup `1.0.0` dry-run left every file unchanged; apply changed only `backup.ts`, `backup.md`, and `.fas-capabilities.json`; repeating apply was idempotent; and an edited prior helper was rejected without writes. Fresh standalone and connected presets both contain the corrected recipe and a link to this guide. The published SDK `0.16.33` backup sample renders plain, truthful restoration-failure text, exposes no developer result code, and removes its view on destroy. Evidence: [independent release verification](https://github.com/freeappstore-online/platform/issues/353#issuecomment-6640907483) and local artifacts `/var/folders/xg/xf69lhnj7zd9khr1_10ps0xr0000gn/T/fas-published-063-review-08l5Uf/migration-review.json` and `published-sdk-ui.json`.

The following runtime checks were performed against the prior published CLI `0.4.62` and SDK `0.16.32`; they remain representative predecessor evidence and were not rerun against `0.4.63` / `0.16.33`. The final release changes generated guidance, sample UI text and PWA test cleanup, not SDK runtime behavior:

| Surface | Verified outcome |
| --- | --- |
| Published CLI `0.4.62` | Fresh standalone and connected apps installed dependencies normally and passed build, typecheck and test. Both retained the correct runtime app identity. |
| Built browser apps | Both presets passed 24 combinations across signed-out/synthetic-auth states, 320/375/430 px viewports and 16/32 px root text. Home/Profile fit, Profile stayed reachable without OAuth, and no page errors or app-id placeholders appeared. Deep links to About/Profile loaded offline through the real service worker. |
| Profile-return regression | On both fresh published presets, `/about?sort=recent#saved` → Profile → Back rendered About before and after reload while preserving the full URL. Evidence: [published 0.4.62 acceptance](https://github.com/freeappstore-online/platform/issues/387#issuecomment-6639943915) and local artifact path `/var/folders/xg/xf69lhnj7zd9khr1_10ps0xr0000gn/T/fas-published-062-review-UXBCFD/profile-query-return.json`. |
| PWA lifecycle | On fresh published CLI `0.4.62` app artifacts prepared with the current synthetic controls, the revised test passed 2/2 desktop/mobile projects for standalone and 2/2 for connected. It covered a waiting update, unsaved edit and recording guards, prompted activation/reload, dirty reload protection, saved reload and offline/deep-link shell behavior at 320 px with enlarged text. Fixture-only inputs were fluid so they did not widen the viewport. |
| Backup/import | A separate fresh published CLI `0.4.62` app passed 11/11 composed cases covering real IndexedDB, WebCrypto/checksum validation, offline save/reload, merge/replace, failed-write rollback and explicit `reason: 'rollback'` with truthful partial-data status. Evidence: [#353 review](https://github.com/freeappstore-online/platform/issues/353#issuecomment-6640242884) and `/var/folders/xg/xf69lhnj7zd9khr1_10ps0xr0000gn/T/fas-composed353-tkmmpP/composed-browser.json`. |
| Connected account and visibility | Accepted SDK/connected-example checks exercise a shared client, sign-out, account changes and stale responses; API contracts distinguish private `fas.kv`, public-read collections, durable data rooms, and ephemeral broadcasts ([#350](https://github.com/freeappstore-online/platform/issues/350)). Room members have equal record CRUD; tests do not claim live OAuth or secrecy from other room members. |
| SDK capabilities | Published checks covered draft behavior under long text ([16 cases](https://github.com/freeappstore-online/platform/issues/378)), Profile/header and appearance in both auth states ([48 browser cases plus 4 persistence cases](https://github.com/freeappstore-online/platform/issues/379)), and actual builder `install_capabilities` execution ([9 checks](https://github.com/freeappstore-online/platform/issues/380)). Actual app identity requests and display-name substitution were verified in [#384](https://github.com/freeappstore-online/platform/issues/384) and [#385](https://github.com/freeappstore-online/platform/issues/385). |
| External mirrors | Final standalone mirror [`ea997c1`](https://github.com/freeappstore-online/template-standalone/commit/ea997c141181a8d218cf0ca1003781992a6baf8b) passed [CI](https://github.com/freeappstore-online/template-standalone/actions/runs/41903251533) and [Compliance](https://github.com/freeappstore-online/template-standalone/actions/runs/41903251558); connected mirror [`47bbcd9`](https://github.com/freeappstore-online/template-connected/commit/47bbcd9da2044afd96840e516c92106d8da604e1) passed [CI](https://github.com/freeappstore-online/template-connected/actions/runs/41903402328) and [Compliance](https://github.com/freeappstore-online/template-connected/actions/runs/41903402366). Both are clean on main; deploy was intentionally skipped. Independent parity checks against the published CLI `0.4.63` generator matched 24/24 standalone and 26/26 connected files. Earlier mirror commits [`4bdd7c6`](https://github.com/freeappstore-online/template-standalone/commit/4bdd7c6864ebc1953cdebe8abf61171a5ed39c9b) and [`b22f680`](https://github.com/freeappstore-online/template-connected/commit/b22f6803f1b85963d87f1ec71d1f0a782ab3e22b) are predecessor baselines. |

This evidence verifies the named release and representative synthetic cases. It does not claim that existing apps have migrated or that every app-specific workflow works offline. Existing custom apps should test their own routes, account switching, busy guards, and data model after any deliberate change.
