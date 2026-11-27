# Desktop and phone roadmap

Product roles, release stages and one ordered backlog for the desktop, Android and iOS apps (#853). Written
2026-11-27 from the code and the open issues. It orders existing issues; it does not replace them. User guide:
[Desktop and phone apps](devices.md).

Status words, used strictly:

- **Implemented**: the code is on `main`.
- **Validated on hardware**: someone ran it on a real device and recorded the result in the issue.
- **Released**: a user can install it without building it.
- **Planned**: an issue exists; no code yet.

## Product roles

Web apps stay the product. Nothing here may become required to use a FreeAppStore app, or hold app data on the server
([ADR-004](https://github.com/freeappstore-online/platform/blob/main/docs/adr/004-no-server-app-data.md)).

| Client | Who and what for | Not for | Next demonstrable outcome |
|---|---|---|---|
| Web | Everyone: use, install and build apps. Zero install | — | — |
| Desktop | People who use an AI app on their computer: let it work on their device-held app data. Optional Contribute | Authoring and publishing apps (#800, deferred until a repeat need is shown); a cloud data service | A signed build that a tester installs and updates without warnings (#807, #808) |
| Android | What the web can't do on a phone: locked-screen location (Run). Optional bounded Contribute, on-device Good / Not good | A second app store; arbitrary background compute | A first tagged, signed build on Play internal testing (#846, #658) |
| iOS | Same as Android | Same as Android | A first tagged build (#846), then the distribution decision below |

Store and Account in the native apps are supporting navigation, not products of their own. Contribute is public
narration only, checked for structure by the server and judged by people (#831). There is no automatic quality or
language promise, and no general compute marketplace.

## Where each client is

| | Desktop | Android | iOS |
|---|---|---|---|
| Released | 0.4.1 preview, unsigned (Mac, Windows, Linux) | No | No (developer install only) |
| AI access (MCP) | Implemented, released | — | — |
| Location for Run | — | Implemented | Implemented |
| Contribute (en, es, zh) | Implemented, released | Implemented | Implemented |
| Auto / Run now / Off and device conditions (#830) | Pause only; no power or heat policy | Implemented | Implemented |
| Account and sign out (#829) | Implemented, released | Implemented | Implemented |
| Reports its version to the devices list (#833) | Implemented, released | In progress | Implemented |
| QR pairing (#845) | Shows the code, released | In progress | Implemented |
| Auto-update (#839) | Windows, Linux; Mac opens the download | — | — |

Nothing in the phone columns is recorded as validated on hardware yet. That is the pilot's job (#790).

## Release stages

Each stage starts when the previous one's gate is met.

**1. Account, privacy and release reliability**
- Done: account isolation on desktop (#848), privacy and data inventory (#849, [where data goes](device-data.md)), user
  guide (#850).
- Gate: desktop installers publish only after tests pass on the release tag (#851); Android signs and uploads only
  after the emulator tests pass (#852); Android and iOS build from the tag and have a first version (#846).

**2. Signing, updates and controlled testers**
- Desktop: macOS Developer ID and notarization (#807), Windows signing (#808), so Mac updates install themselves.
  Remaining part of #799.
- Android: Play Console setup and listing (#654, #655), Store tab policy (#656), background location declaration
  (#650), in-app account deletion (#653). Epic #658.
- iOS: the decision below.
- Gate: a named tester installs each client from a link, updates it, and reports through the support path in the
  user guide.

**3. Measured improvement**
- The physical-device pilot (#790) with one shared batch, using device-side controls (#830). Desktop needs a power
  and heat policy like the phones' before it is part of the pilot.
- Gate: the pilot's numbers (below) are recorded in #790.

### iOS distribution

Today: developer install from Xcode only. Proposed: stay developer-only for the pilot (#790). Move to TestFlight only
when all of these hold:

- an Apple Developer Program team and signing credentials stored through `~/dev/ops` (a human action; this roadmap
  authorizes none);
- a named owner for builds, tester invites and support (Serge, unless he names someone);
- the user guide and privacy policy cover iOS (they do as of #849 and #850);
- the pilot shows background Contribute and location are useful on a real iPhone.

Exit, if they don't hold after the pilot: iOS stays a developer build and the web app is the iPhone product. No App
Store submission is implied.

## Pilot measurements

From data the platform already records, with the pilot users' knowledge. No new tracking.

| Measure | Source |
|---|---|
| Useful outputs: accepted and reviewed good, per device and per day | Submissions and owner reviews (#831, #842) |
| Loss: interrupted, given back, retried, failed, by reason | Attempt records (`…/generation/events`, kept 14 days) |
| Cost: CPU time, wall time, peak memory, battery and heat at start and end | Attempt records |
| Repeat use: days each device contributed in the pilot | Submissions |

Expand (stage 2 testers to more users) when most attempts finish without loss and testers keep contributing without
prompting. Stop or narrow a client when it produces little accepted audio for its cost or interruptions dominate.
These thresholds are for the owner to set in #790.

## Backlog, reconciled

In order. "Code landed" means commits on `main` reference it; it stays open until its acceptance is checked.

| Order | Issue | State |
|---|---|---|
| 1 | #851 desktop release gate, #852 Android release gate | Code landed; confirm on the next release run |
| 2 | #846 first Android and iOS versions from the tag | Code landed; versions not cut |
| 3 | #845 QR pairing | Backend, console, desktop, iOS landed; Android in progress |
| 4 | #826, #828, #830, #833, #835, #836, #844 phone and desktop Contribute | Code landed; needs hardware validation (#790) |
| 5 | #813 generation troubleshooting | Code landed in several parts; check acceptance |
| 6 | #807, #808 desktop signing (rest of #799) | Planned; needs credentials |
| 7 | #658 Play readiness: #654, #655, #656, #650, #653 | Partly landed (#650, #653, #655 have commits); #654 needs a human |
| 8 | #790 pilot, with #792 and #789 | Planned |
| 9 | #788 model catalogue, #732 attestation | Planned; #732 needs a human |
| 10 | #724 web vs native identity on iPhone | Planned |
| — | #800 desktop authoring | Deferred (see roles) |

Overlaps and old tickets, to check before closing (this roadmap closes nothing):

- **#809 and #839** (auto-update): both closed; shipped in desktop 0.4.0. #799 now only tracks signing.
- **#611–#615** describe an older design (end-to-end encrypted points over rooms). ADR-002 chose the native API
  instead, implemented under **#616–#621** (commits on 2026-11-23). #611–#615 look superseded and #616–#621 look done;
  audit their comments and acceptance before closing.
- **#792** (server-enforced contributor budgets) conflicts with #830 (no per-user server cap; limits on the device).
  The device side is done; the server-side part looks superseded.
- **#787 and #791** (owner review): reviews per exact version, the review queue and audit (#831, #842) landed. Check
  what is left.
- **#786** is the design question behind #788–#790; keep it until the pilot reports.
- **#727** is the epic for all of the above.

Catalogue-app follow-ups (Books, Dialogue, Run) stay on their own app repos.
