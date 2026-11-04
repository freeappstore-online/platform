# Pitstop Log: first-build experience review

This review covers the real Car fuel & expense log build chosen from the storefront
ideas list on 2026-11-04, the resulting Pitstop Log repository, its independent browser
QA, and the platform code that supplied the scaffold and development guidance.
It is one representative local-data app, not a benchmark of every app or provider.

## Verdict

The initial creation experience was not straightforward. The finished app works, but
getting there required repeated platform repairs and manual product QA. “An app was
deployed” substantially overstated the initial useful outcome: its first runtime load
failed, and ordinary sequential typing and invalid backup handling were still broken.

The first tracked platform failure was filed at 20:53 UTC. The first app runtime defect
was filed at 21:36; the initial eight app defects were closed after verification around
22:04. That is at least 71 minutes from the first tracked failure to accepted core app
repairs. It includes debugging and verification, not just model generation time, and
does not establish the total elapsed time from the original prompt.
The later Profile-close change was user feedback and a separate release, not another
initial-build failure.

## What actually went wrong

| Layer | Evidence | Consequence | Disposition |
|---|---|---|---|
| Builder conversation | Platform #390: unmatched tool-result history | Build could not continue reliably | Repaired, with history regression coverage |
| Observability | #391: missing engine state and useful tool outcomes | “Finished” obscured errors and made supervision guesswork | Repaired; distinguish working, idle and error |
| First deployment | #392: Git Data upload into an empty repository | New app could not provision successfully | Bootstrap repaired |
| SDK consumption | Pitstop #1: wrong openStore, result and preference signatures | First page could not load data | App repaired; #393 added deploy typecheck |
| Capability setup | #394: fresh root SDK prerequisite not prepared | Persistence/backup recipes were omitted and rewritten by the model | Fresh-only preparation repaired; existing-app checks retained |
| Backup | Pitstop #2: invalid records filtered into an empty replacement | Malformed import could erase data | Shared helpers, strict validation, preview, explicit mode and rollback QA |
| Routing | Pitstop #3: full URL used as a screen-switch key | Log URL rendered Dashboard after Profile return | App repaired; review found the same mistake still in the MCP example |
| Forms | Pitstop #4, #6–#8: missing label associations, cramped inputs, permissive parsing, focus reset | Inputs appeared to work under fill(), but people could not type normally | App repaired through keyboard and visual QA |
| Domain logic | Pitstop #5: arithmetic mean of consumption rates | Unequal distances produced a wrong average | App-owned weighted calculation and regression |
| Account UX | #397 / Pitstop #9 | Extra return row and dead avatar on Profile felt clumsy | Shared close control, published SDK and template adoption |
| Release delivery | #395, #398: stale mirrors/locks and false registry readiness | Published fixes did not reliably reach a fresh install | Mirrors refreshed; bounded install-resolution retry hardened |
| App identity | #399 / Pitstop #10: SVG existed but no favicon link | Browser tab had no declared app icon | Canonical HTML wiring and artifact verification |

Issue links: [platform](https://github.com/freeappstore-online/platform/issues),
[Pitstop](https://github.com/freeappstore-online/pitstop-log/issues).

## Remaining causes found in the assets

The guidance gave abundant visual rules but insufficient executable API examples.
Persistence named openStore and putRecord without demonstrating their argument/result
shapes. Backup accessed value without narrowing ok and referred to undefined schema and
callbacks. Reference tests mostly checked whether words appeared, so invalid examples
could pass. The MCP router also retained the exact full-URL/pathname mistake.

Capability installation is infrastructure preparation, not feature integration. The
tool returned changed filenames and prerequisites, but did not direct the model to the
installed guides. The implementation now returns explicit guide paths. The shared
storage examples are compiled against actual SDK types and used in both the capability
guides and MCP reference.

The SDK Modal already protects focus when inline callbacks change. Pitstop created a
parallel modal implementation and reintroduced that problem. Guide authors toward the
existing control before adding new component primitives.

The local clone also had no committed dependency lockfile: installation generated one
and resolved hundreds of packages. Reproducing the accepted source therefore does not
yet guarantee reproducing its dependency graph; follow-up #403 addresses builder and
deployment policy together.

Several claims and instructions had drifted: “Shell required” versus supported custom
frames, theme controls in a header that now puts appearance in Profile, and “build →
deploy” without meaningful runtime acceptance. These should be consistent across the
builder prompt, MCP handoff, generated contributor guidance and documentation.

## Where each improvement belongs

| Location | Provide by default | Keep optional/app-owned |
|---|---|---|
| Small starter foundation | Runnable package setup, typecheck/test/build commands, linked app identity, accessible default navigation, one PWA controller, empty/loading/error examples | Branding, information architecture, screen layouts and routes |
| SDK | Correct storage primitives, explicit failure results, accessible reusable controls, account lifecycle, backup mechanics | Domain schema, merge policy, calculations, authorization decisions |
| Composable recipes | Complete typechecked persistence/backup examples; later addition through the same conflict-aware installer | Install only the capabilities the feature needs; never attach every feature automatically |
| Verification assets | Real typing, label checks, reload persistence, safe profile return, invalid import and identity-asset checks | Product-specific acceptance flows and numerical test cases |
| Builder/runtime | Accurate tool outcomes, recoverable sessions, actionable build errors, source-specific deployment status | Product intent and design decisions |
| Release tooling | Registry/install readiness, actual published-package tests, mirror parity and current locks | Existing app upgrades remain deliberate |

Two editable starting modes plus composable capabilities remain sufficient here. This
build does not justify a template for every feature combination, a mandatory CRUD model,
a fixed database schema, or exact UI markup gates.

## Prioritized next work

1. **P1: repeatable end-to-end creation evaluation (#401).** Start a new app from an idea, add a
   small useful feature, and measure fresh-load, actual typing, save/reload, typecheck,
   deploy and first useful outcome. Retain failed-stage evidence. One repaired sample
   must not become the only golden path.
2. **P1: complete mobile identity assets (#402).** Favicon wiring is fixed, but SVG-only PWA
   icons and no PNG/touch-icon recipe leave older-browser/install coverage uncertain.
   Add an optional asset-generation pathway and test the declared assets; do not fake
   PNG/ICO files or require a particular artwork/name.
3. **P2: strengthen reusable forms and dialogs.** First document the SDK controls that
   already exist and test focus lifecycle under typing. Add missing primitives only
   after confirming actual gaps; avoid another parallel component system.
4. **P2: release/mirror automation.** Generate and verify the two mirrors from the same
   accepted release, keeping package resolution visible. Avoid human repetition of
   several nearly identical release steps.
5. **P2: improve local diagnostics.** A single verification entry point should report
   identity, installed versions and validation stages without turning every optional
   capability or visual convention into a hard failure.

## Limits and operator friction

The successful final app required intervention by the supervising developer; it is not
evidence that the original builder independently recovered all defects. Real GitHub and
Google OAuth were not exercised; signed-in UI checks used synthetic data and API mocks.
Most initial tests used Chromium, so they do not establish Safari or physical-device
coverage. Device-local data is not account synchronization.

The development workflow itself added friction: remote-runner attachment diagnosis,
repeated tool-history recovery, manual release monitoring and mirror updates. Some
review messages interrupted a running engine and triggered known session-history
corruption. That operator overhead should be counted separately from app/template
quality, rather than blamed entirely on the model. The owner has now requested local
coding; remote auto-pickup was disabled and the active remote run stopped. Local
execution provides direct compiler/test output and removes that orchestration layer
from this iteration.

The next evaluation should compare the repaired platform against this baseline using
the same observable user flows, and then another independently designed app. Success
means less intervention and a useful verified feature, not just more generated files.
