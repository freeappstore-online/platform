# Native security and distribution audit — 2026-11-28

Tracked in [#857](https://github.com/freeappstore-online/platform/issues/857). This is a repository and local-build
review, with automated regression tests and a physical iPhone install. It is not an independent penetration test
or a claim that every native dependency has been audited. Existing downloadable desktop 0.6.0 builds remain unsigned
previews. Do not label them signed or remove their first-launch instructions.

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

The same sharp advisories were also present in the Creator Console's generation dependencies. Its lockfile now
pins sharp 0.35.5; the console audit is clean, its production build succeeds and all 125 tests pass. Desktop CI
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
a release tag. All three platform builds and the existing desktop test workflow must pass before publishing.

Use the ops store and an ops issue to provision these scoped GitHub Actions secrets; never paste credentials in
issues, source files or command arguments:

| Configuration | Purpose |
| --- | --- |
| `MAC_CSC_LINK`, `MAC_CSC_KEY_PASSWORD` (secrets) | Base64 Developer ID Application P12 and its password |
| `APPLE_API_KEY_BASE64`, `APPLE_API_KEY_ID`, `APPLE_API_ISSUER` (secrets) | App Store Connect API key for notarization; restored only to a private runner temp file and removed on exit |
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

- **macOS:** no Developer ID Application certificate/private key or notarization API key is provisioned for this
  repository. The local keychain has development identities only. The Apple Account Holder must issue Developer ID
  ([#807](https://github.com/freeappstore-online/platform/issues/807)).
- **Windows:** no signing identity/provider is provisioned. Publisher identity and provider must be established
  ([#808](https://github.com/freeappstore-online/platform/issues/808)). Microsoft Artifact Signing eligibility must
  be checked for the actual publisher; do not assume an Australian individual qualifies.
- **iOS:** the paid team's development-signed 0.2.0 build installs on the paired iPhone. Apple Distribution,
  distribution provisioning, App Store Connect credentials, TestFlight/App Store release workflow and store review
  remain outstanding. No simulator or development-signed binary may be advertised as a public iPhone release.
- **Android:** signed release builds exist in CI. Public Play availability still requires the listing, declarations,
  testing/review and release-track work tracked in [#654](https://github.com/freeappstore-online/platform/issues/654).
- The new signed desktop path has not run successfully with real credentials. Both Mac architectures and Windows
  must be smoke-tested from the final signed packages before the download page can claim signed availability.
