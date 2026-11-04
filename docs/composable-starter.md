# Composable starter contract

This is the FAS contract for epic #342, beginning with #343. It describes the
target architecture; the availability table distinguishes shipped features from
planned work. It does not authorize changes to other stores or app repositories.

## Foundation, capabilities and presets

Maintain one canonical React/Vite/Tailwind/token foundation. Standalone and
connected are presets composed from optional capabilities, not separate runtime
implementations. A preset selects capabilities and initial app-owned examples;
it does not prescribe product layout, domain models or workflows.

| Area | Available today | Ordered delivery |
| --- | --- | --- |
| Scaffolding | `fas init` clones standalone/connected template repositories | #352 generates both presets and builder seeds from one foundation |
| Identity/deploy | CLI app-id validation; builder build-sanity and baseline/delta deploy | #344 validates SDK identity and the actual build/upload target |
| Capabilities | SDK exports and hand-authored configuration | #345 adds a minimal registry and `fas add`; this command is not available today |
| PWA | Existing manifests, service workers and online status UI | #346 delivers safe update/offline lifecycle contracts |
| Frame/account/routes | `Shell`, `renderNav`, `profileHref`, `NavBar`, `ProfilePage`, SDK auth/theme hooks | #347 adds composition primitives; no new provider or frame props are promised today |
| Local data | Browser storage APIs | #348 adds validated persistence and explicit save failures |
| Portable data | App-authored import/export | #349 adds validated backup/import and browser file export recipes |
| Cloud | SDK KV, public collections and rooms | #350 documents access guarantees and provides race-safe examples |
| Realtime/media | Existing SDK/browser facilities | #351 adds optional lifecycle-tested recipes |
| Adoption | Existing published SDK and template smoke checks | #353 verifies composed release, fresh scaffolds and adoption guidance |

## Ownership and updates

Version runtime infrastructure in SDK/packages: auth/session handling, frame
primitives, persistence helpers and PWA lifecycle support. Generated screens,
routes, configuration and domain models belong to the app. An SDK upgrade must
not silently replace app-owned source or user data.

The planned registry is a small typed list of versions, dependencies, files and
checks, not a generic plugin framework. Planned add/update operations must be
idempotent, support dry-run, record generated-file provenance, and detect edits
before overwriting. Conflicts require an actionable diff; preserve existing
source and stored data. Removal must not delete user data implicitly.

## Defaults and requirements

React + Tailwind 4 on FAS tokens and the SDK `Shell` are the recommended app
defaults. Platform-owned SDK, templates, console, admin and storefront retain
their styling discipline. Apps may use custom frames, sidebars, bottom navigation,
tabs and nested/detail routes. Primary navigation need not list every detail
screen. Existing `renderNav` stays inside the Shell topbar; a wholly custom frame
can compose existing exports while later primitives are developed in #347.

Hard checks address security, the deployed artifact, accessibility and data
integrity. Preserve accessible names, keyboard navigation, visible focus,
landmarks, route focus/history, theme contrast and platform identity. Do not
replace these behavioural requirements with a source-only Shell import check.

The default topbar shows the app name only and a compact avatar. The avatar
navigates to profile in both auth states; GitHub/Google choices live on profile.
Custom account pages must preserve auth lifecycle, sign-out and deletion cleanup.
Use SDK actions rather than duplicating token/session management. Attribution
footers/bars are optional; do not add invisible links to satisfy source checks.

Allow browser page zoom by default. Scope gesture suppression to an interactive
canvas that needs it, rather than disabling zoom or touch behaviour globally.

## PWA and data guarantees

Installability, useful offline behaviour and safe updates are separate contracts.
A manifest or online banner does not prove offline capability. Describe which
operations work offline and surface unavailable network features honestly. Never
force reload a dirty document, pending save or active recording; activation needs
an explicit safe point. Preserve work across errors and updates.

Name data access explicitly:

| Model | Guarantee |
| --- | --- |
| Device-local | Stored in this browser; can fail, be evicted or disappear on clearing storage |
| Private-account | Server-enforced ownership for the signed-in account; authentication alone is insufficient |
| Public-shared | Readable by others under the published collection policy; visual concealment is not confidentiality |
| Room-restricted | Requires server-enforced membership/authorization; current public collections do not provide private rooms |

Validate imported/persisted data before applying it. Report failed saves and
retain recoverable input. Examples must handle auth changes and stale async
responses without leaking one account's state into another.

## Existing machinery and incremental file plan

Reuse #18's `workers/agent/src/template.ts` archetypes and `session.ts` baseline
selection. Reuse #10's `build-sanity.ts`/`infra-exec.ts` pre-deploy gate and #13's
`deploy.ts` baseline/delta merge. These protect source/deploy ownership but do not
yet establish the identity or artifact guarantees in #344. SDK #337–#340 already
provide profile routing, URL state, shared preferences and auth lifecycle fixes;
extend those implementations rather than introducing parallel account handling.

1. #344: extend `packages/cli/src/commands/check.ts`, CLI publish/deploy paths
   and builder `build-sanity.ts`/`infra-exec.ts` with identity and target validation.
2. #345: add CLI registry/add modules alongside `commands/init.ts`; test repeat
   execution, dry-run, conflicts and data preservation with temporary projects.
3. #346: add SDK PWA lifecycle exports and registry recipe/config; test real
   offline operations and deferred activation with dirty work and recordings.
4. #347: extend `packages/sdk/src/ui` and routing/account tests; demonstrate
   custom frames without querying or rewriting internal DOM.
5. #348: add SDK storage helpers and failure/schema regressions, then wire the
   capability's app-owned example through them.
6. #349: add import/export recipes with schema validation, atomic apply and
   browser download fallbacks; test malformed backups and cancellation.
7. #350: update SDK/cloud docs and connected examples with explicit policy
   labels, auth transition tests and stale-response guards.
8. #351: add optional realtime/media recipes with teardown, reconnect,
   permission-denial and interrupted-operation tests.
9. #352: generate CLI template inputs and builder `getTemplateFiles` from the
   canonical foundation; retain archetypes, delta baselines and app edits.
10. #353: extend `packages/e2e/scaffold` and release guidance; verify published
    versions, fresh scaffolds and exact-SHA CI/deploy evidence before adoption.

These are implementation locations, not shipped API signatures. Each child must
verify its predecessor's delivery before starting dependent work. Independent
supervisor review and relevant exact-SHA CI/deploy and published-package evidence
are acceptance gates. Keep #342 open until all children and rollout validation
are verified.

## Relationship to styling work

#318's platform styling work remains valuable. #326's blocked fleet migration is
not restarted by this contract; do not bulk-edit apps or flip warn checks to fail.
#327 concerns a shared cross-store design document: this FAS-local clarification
does not change sibling-store policy or claim that shared work is complete.
The app defaults above supersede blanket layout/stack mandates in FAS guidance;
platform-owned UI keeps ADR-001's component/token rules and opaque surfaces.
