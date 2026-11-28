# Native security and distribution audit — 2026-11-28

Tracked in [#857](https://github.com/freeappstore-online/platform/issues/857). This is a repository and local-build
review, with automated regression tests and a physical iPhone install. It is not an independent penetration test
or a claim that every native dependency has been audited. Existing downloadable desktop 0.6.0 builds remain unsigned
previews. They are no longer eligible for the recommended download page; do not label them signed.

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
| Release pipeline could publish unsigned installers | Require credentials before tagging, fail on signing failures, verify expected publisher and notarization, publish signed provenance | actionlint, script syntax and updater-hash regression test. Successful signed builds still require the credentials below. |

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
it does not require exporting Apple's private signing key. See [desktop/SIGNING.md](../desktop/SIGNING.md).

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

- **macOS:** cloud-managed Developer ID signing, accepted notarization, stapling and Gatekeeper acceptance have
  been verified using the existing Xcode account (ops#61). A fresh release for both architectures must still pass
  source-bound CI verification and publication. Exportable P12/API credentials are absent but are no longer a
  blocker for this account-backed route. The public CSR and encrypted private key prepared in ops#61 remain an
  unused fallback; they are not the cloud-managed key.
- **Windows:** Microsoft Store submission packaging is implemented, including Store-managed updates/startup and
  a CI-only package fixture. Actual submission requires a reserved Partner Center identity, a 1.x package version,
  listing/certification and an installable Store product. See [desktop/SIGNING.md](../desktop/SIGNING.md) and
  [#808](https://github.com/freeappstore-online/platform/issues/808). No production Store package or listing is
  claimed from the fixture. Direct EXE distribution remains optional and requires a validated signing provider
  plus actual installation checks.
- **iOS:** the paid team's development-signed 0.2.0 build is on the paired iPhone; this is not TestFlight delivery.
  The existing Xcode account successfully exported an Apple Distribution-signed archive for team `55DT52UQXE`,
  so account-backed distribution signing works. CI produced a verified SDK 26.5 archive, 0.2.0 build 55, and the
  existing account signed its IPA successfully. Upload reached authenticated App Store Connect, which returned
  zero app records for `online.freeappstore.companion`; create the app record, retry the prepared build, then
  configure/verify TestFlight tester access. These steps remain tracked in
  [#863](https://github.com/freeappstore-online/platform/issues/863). CI credentials remain unprovisioned but are
  not required for this account-backed upload route.
  No simulator or development-signed binary may be advertised as a public iPhone release.
- **Android:** internal Play testing is live as recorded above. Public Play availability still requires the listing, declarations,
  testing/review and release-track work tracked in [#654](https://github.com/freeappstore-online/platform/issues/654).
- The new signed desktop path has not run successfully with real credentials. Both Mac architectures and Windows
  must be smoke-tested from the final signed packages before the download page can claim signed availability.
