# Native security and distribution audit — 2026-11-28

Tracked in [#857](https://github.com/freeappstore-online/platform/issues/857). This is a repository and local-build
review, with automated regression tests and a physical iPhone install. It is not an independent penetration test
or a claim that every native dependency has been audited. Historical desktop 0.6.0 builds remain unsigned previews and are not eligible for the recommended download page.
Desktop 1.0.2 is published with Developer ID-signed, notarized Mac ZIPs for Intel and Apple Silicon,
and a Linux AppImage. The [current release workflow](https://github.com/freeappstore-online/platform/actions/runs/46135844563)
passed all tests and verification gates before publication. Anonymous public downloads, GitHub asset digests,
manifest hashes, hosted-workflow attestations and both updater aliases were independently verified afterwards.
The [original 1.0.0 workflow](https://github.com/freeappstore-online/platform/actions/runs/46121391118)
remains historical evidence of the first verified production release.

## Installation channels

The requested installation policy is TestFlight for iPhone, Google Play testing for Android, and verified
desktop downloads from the website. Do not install phone builds directly with devicectl/ADB or tell users to
bypass Gatekeeper/SmartScreen. Existing phone data must be preserved when moving to store distribution.

Android 0.2.0 (version code 62, following the initial manual release 61) is published to the **internal** Play track and was verified through a fresh
Publisher API edit. The owner-only tester list is selected and the track is Active. Eligible testers can
[join through Google Play](https://play.google.com/apps/internaltest/4701334236045250583). This is not public
production availability. Future Android main builds publish to internal testing only after build and emulator
checks pass. Evidence is recorded in [#857](https://github.com/freeappstore-online/platform/issues/857).

The storefront requires `FreeAppStore-signing.json`, its cryptographically verified provenance from the trusted
desktop release workflow, the versioned Mac/Linux installer set, and matching GitHub asset SHA-256 digests before showing downloads.
Direct Windows installers are optional; Windows Store preparation must not block Mac delivery. Missing/unavailable evidence yields a
downloads-coming-soon message, never a fallback to the old unsigned `desktop-latest` assets. Windows links also
require actual installation/SmartScreen verification; a valid Authenticode signature alone is insufficient.
The signing manifest is release-pipeline evidence, not a replacement for independently verifying downloaded
installer signatures. The storefront runs `gh attestation verify` on that manifest, with the expected repository,
workflow identity and main/version-tag ref, before trusting its eligibility flags.

## Findings addressed

| Finding | Change | Verification |
| --- | --- | --- |
| Electron's default automatically approves web permissions | Explicit check/request handlers; camera, microphone, location and notifications ask with the requesting origin; approvals last for the app window. Subframes and unsupported permission classes are denied. Home/encoder session denies all web permissions. | Scoped grants, camera versus microphone separation, subframe refusal, stale navigation approval regression tests; Electron end-to-end suite |
| A malformed HTTP URL could throw before local MCP/bridge validation | Catch URL parse failures on HTTP and upgrade paths, return 400 | Raw socket tests for both paths followed by a successful MCP request |
| Three high advisories in transitive sharp 0.34.5 | Pin transitive sharp to 0.35.5 | `pnpm --dir desktop audit`; packaged native-addon check |
| Moderate minimatch advisory in packaging dependencies | Pin affected versions to 11.0.1 | Audit plus actual electron-builder packaging |
| Pairing/profile requests could hang or follow redirects with request bodies | Reject redirects, cap requests at 20 seconds | Device/API regression suite |
| App discovery waited for generation conditions and could remain on Loading | Separate bounded, cancellable read-only discovery from job execution | Off/paused/manual refresh, timeout/retry and account-change tests; Electron integration test (#858) |
| AI activity disappeared on process exit | Atomic private local metadata history, bounded to 1,000 calls; visible read/write errors and explicit clearing | Actual MCP call followed by Electron restart and durable clearing (#859) |
| Release pipeline could publish unsigned installers | Require credentials before tagging, fail on signing failures, verify expected publisher and notarization, publish signed provenance | actionlint, script syntax and updater-hash regression test. Both real cloud-signed Mac packages passed hosted signature/notarization/source verification in runs 46121391118 (1.0.0) and 46135844563 (1.0.2). |
| Home overstated AI privacy with “Nothing is sent to a server” (#865) | Explain that the connection stays on this computer, while the AI app receives tool results and may send them to its model provider | Inspected both final signed 1.0.2 ASARs: corrected wording present and old sentence absent. CI independently matched packaged renderer files to a fresh build of tagged source `6bcf052b307b5161556601c8fc24d436cb2d8e2a`; public download hashes and attestations match. |

Advisories: [sharp/libvips](https://github.com/advisories/GHSA-f88m-g3jw-g9cj),
[sharp HEIF](https://github.com/advisories/GHSA-rgj7-g3m4-5g8c),
[sharp](https://github.com/advisories/GHSA-wq5f-xc86-pv6w),
[minimatch](https://github.com/advisories/GHSA-g3hv-75wg-m249).
Permission behavior: [Electron security guidance](https://www.electronjs.org/docs/latest/tutorial/security#5-handle-session-permission-requests-from-remote-content).

The same sharp advisories were also present in the root workspace's transitive development tooling and the
Creator Console's generation dependencies. Both lockfiles now override vulnerable transitive sharp versions
with 0.35.5; both full npm audits are clean. The console's production build succeeds and its tests pass. Desktop CI
passed on macOS (both architectures packaged), Windows and Linux in
[run 46091031662](https://github.com/freeappstore-online/platform/actions/runs/46091031662).

## Boundaries reviewed

- Desktop renderer sandbox and context isolation are enabled; Node integration is disabled. The app bridge validates
  its top frame and exact app origin. Home IPC validates the home window and top frame. App navigation remains on
  its assigned origin. Other HTTP(S) links go to the system browser.
- MCP binds only to 127.0.0.1, uses constant-time bearer validation and rejects browser Origin headers. The browser
  bridge binds each approved origin to its own app ID. Messages are bounded to 1 MB and tool calls time out.
- Desktop device/MCP credentials are private userData files, not exposed to hosted apps. This does not protect
  against another process already running as the same OS user. AI call metadata is local and separate from
  account-scoped Contribute history; no tool inputs/results enter the new persistent activity file.
- iOS uses Keychain for credentials; Android uses Android Keystore encryption. Release networking uses HTTPS;
  mobile API clients refuse redirects. Local mobile contribution/location data is excluded from backups.
- Native model downloads have pinned hashes. This review did not independently audit sherpa-onnx, ONNX Runtime,
  codecs or model archives. npm auditing covers the JavaScript dependency graph, not all native binary CVEs.
- Android's release script verifies both APK and AAB signers against the committed public upload certificate.
  iOS development signing permits device installation; it does not establish App Store/TestFlight readiness.

## Public desktop signing gate

`.github/workflows/desktop-release.yml` uses `desktop/electron-builder.release.yml`. Local/CI smoke packages retain
the preview configuration and are never promoted by this workflow. Missing configuration fails **before** creating
a release tag. Mac/Linux builds and the existing desktop test workflow must pass before publishing. Direct
Windows builds are opt-in with `DESKTOP_WINDOWS_DIRECT_ENABLED=true`; missing Windows credentials then fail the gate.

An alternative using the already-authorized Xcode account has now been proven: Apple's cloud-managed Developer ID
signing and notarization produced an app accepted by Gatekeeper after ZIP extraction and quarantine was applied.
That probe was an old development package and is not a release candidate. `desktop/scripts/cloud-sign-mac.sh`
builds both architectures from an exact release tag for the separately verified cloud-release promotion path;
it does not require exporting Apple's private signing key. The production 1.0.0 release followed this route for
both architectures. CI compared the packaged JavaScript with a fresh build of tagged source
`3fe64a94bd0d74cdd838441adc72ce8352b63b4a`, checked archive safety and full installer hashes, then verified
Developer ID, hardened runtime, stapled tickets and Gatekeeper acceptance before publishing. The provenance
records the verification workflow and its source separately from the application source. It attests these checks;
it is not a claim of a fully reproducible native build or an independent rebuild of Electron and its native dependencies.
See [desktop/SIGNING.md](../desktop/SIGNING.md).

The current 1.0.2 release, build `2026112803`, repeats those checks against application source
`6bcf052b307b5161556601c8fc24d436cb2d8e2a`. Its trusted main verifier was
`48b6fe8982f08603345082d01c00f81ab667cb7c`, recorded separately in the manifest. The final signed
apps also contain the verified padded 1024px Mac icon and corrected AI-provider privacy wording.
Every public installer and the signing manifest passed `gh attestation verify` with the exact
cloud-release workflow identity on main and `--deny-self-hosted-runners`. The versioned Mac/Linux
updater hashes match the final downloaded bytes, and `desktop-latest` serves identical updater files.
Version 1.0.1 remained a private draft when a Markdown formatting check failed; it was never promoted.

Use the ops store and an ops issue to provision these scoped GitHub Actions secrets; never paste credentials in
issues, source files or command arguments:

| Configuration | Purpose |
| --- | --- |
| `MAC_CSC_LINK`, `MAC_CSC_KEY_PASSWORD` (secrets) | Base64 Developer ID Application P12 and its password |
| `ASC_API_KEY_P8_BASE64`, `ASC_API_KEY_ID`, `ASC_API_ISSUER_ID` (secrets) | Shared App Store Connect API key for notarization and TestFlight; restored only to a private runner temp file and removed on exit |
| `APPLE_TEAM_ID` (repository variable) | Expected Developer ID team; verify against the issued certificate |
| `WIN_CSC_LINK`, `WIN_CSC_KEY_PASSWORD` (secrets) | Windows Authenticode certificate accepted by electron-builder's signtool integration |
| `WINDOWS_SIGNING_THUMBPRINT` (repository variable) | Exact expected certificate thumbprint, checked on both the application and installer |

Mac checks require Developer ID, the expected team, hardened runtime, a valid deep signature, a stapled app and
Gatekeeper acceptance. DMGs are separately notarized/stapled; generated updater hashes are recomputed afterwards.
Windows checks require a valid expected signature and timestamp. Every installer, including Linux AppImage, gets
GitHub OIDC signed build provenance and a downloadable Sigstore bundle. Verify provenance using
`gh attestation verify <installer> --repo freeappstore-online/platform`.

This Windows configuration supports an existing exportable certificate. If the publisher uses a hardware-backed
provider or Microsoft Artifact Signing, wire that provider's signing integration and keep the final publisher and
timestamp checks. Do not export a non-exportable key or downgrade its protections.

## Outstanding release requirements

- **macOS:** [desktop 1.0.2](https://github.com/freeappstore-online/platform/releases/tag/desktop-v1.0.2),
  build 2026112803, is published for Intel and Apple Silicon. Cloud-managed Developer ID signing, accepted
  notarization, stapling, ZIP extraction with quarantine, Gatekeeper and source-bound hosted CI verification passed.
  No Gatekeeper bypass is required. Exportable P12/API credentials are absent and unnecessary for this account-backed
  route. The public CSR and encrypted private key in ops#61 remain an unused fallback, not the cloud-managed key.
- **Windows:** Microsoft Store submission packaging is implemented, including Store-managed updates/startup and
  a CI-only package fixture. Actual submission requires a reserved Partner Center identity, a 1.x package version,
  listing/certification and an installable Store product. See [desktop/SIGNING.md](../desktop/SIGNING.md) and
  [#808](https://github.com/freeappstore-online/platform/issues/808). No production Store package or listing is
  claimed from the fixture. Direct EXE distribution remains optional and requires a validated signing provider
  plus actual installation checks.
- **iOS:** **FreeAppStore Companion 0.2.0 (55)** is available to the owner through internal TestFlight testing.
  The App Store Connect record is `6840294127`, bundle `online.freeappstore.companion`; the shorter listing name
  FreeAppStore was unavailable. The existing Xcode account signed CI's verified SDK 26.5 archive with Apple
  Distribution for team `55DT52UQXE` and uploaded it successfully. Apple processing completed; the internal group
  has one build with status **Testing** and one owner tester with status **Invited**. This was verified in the
  App Store Connect UI on 2026-11-28. Beta description, support/privacy links and testing notes are saved.
  Physical TestFlight installation and fresh contribution are not yet verified. There is no public beta invitation
  or production App Store listing. These remaining checks stay in
  [#863](https://github.com/freeappstore-online/platform/issues/863). CI credentials remain unprovisioned but are
  unnecessary for the proven account-backed upload route. Apple accepted SDK 26.5 with an advisory that uploads
  from April 2027 require SDK 27 or later; update the build environment before that deadline.
- **Android:** internal Play testing is live as recorded above. Public Play availability still requires the listing, declarations,
  testing/review and release-track work tracked in [#654](https://github.com/freeappstore-online/platform/issues/654).
- The cloud-managed Mac/Linux release path completed successfully with real signed Mac artifacts. Windows remains
  unavailable until its own Store certification and actual installation checks pass; it does not block verified Mac downloads.
