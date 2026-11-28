# Trusted desktop distribution

The public download page must promote only verified installers. An ad-hoc Mac build or an
unsigned Windows EXE is a development artifact, not a public release. Do not ask users to
disable Gatekeeper, remove quarantine, or choose “Run anyway”.

## macOS website downloads

The optional certificate-based CI route uses `electron-builder.release.yml`: Developer ID Application, hardened runtime, notarization,
and stapling. `verify-mac-release.sh` verifies both architectures, the apps extracted from the
shipped ZIPs, and Gatekeeper acceptance of the stapled DMGs. It writes its receipt only after
every check succeeds, then refreshes updater hashes because stapling changes the DMG bytes.

Required repository secrets for that optional route: `MAC_CSC_LINK`, `MAC_CSC_KEY_PASSWORD`, and the same
`ASC_API_KEY_P8_BASE64`, `ASC_API_KEY_ID`, `ASC_API_ISSUER_ID` used by TestFlight. The repository
variable `APPLE_TEAM_ID` pins the expected team. Provision through the ops store only, under
[ops#61](https://github.com/serge-ivo/ops/issues/61); never paste private keys into issues.
Automatic tag-triggered certificate releases additionally require
`DESKTOP_CERTIFICATE_RELEASE_ENABLED=true`; the manual certificate workflow remains available.
Leave that opt-in unset when using the separate cloud-managed signing promotion route.

As of 2026-11-28, no local Developer ID private signing identity is installed. A public CSR is prepared at
`build/signing/FreeAppStore-Developer-ID.certSigningRequest` in the local platform checkout.
Its matching private key is stored only as encrypted
`fas/MAC_DEVELOPER_ID_PRIVATE_KEY_BASE64` in ops, with no CI consumer. For the optional exportable-key
CI route, the Account Holder can issue a Developer ID Application certificate for this CSR.
This step is not required for the verified Xcode cloud-managed route below. Verify any returned certificate's public key before combining
it with the stored private key and placing the signing bundle through ops. This does not require
a second private key or a new Apple Developer membership.

[Apple's certificate procedure](https://developer.apple.com/help/account/certificates/create-developer-id-certificates/)
requires Account Holder access. The previously documented claim that an ASC API key was already
stored was stale: the PAS entries were still pending in ops#58 when checked. Do not infer a usable
credential from an inventory entry.

### Existing Xcode account: cloud signing and notarization

The existing authorized Xcode account can also sign through Apple's cloud-managed Developer ID
service and submit for notarization. This path was verified on an isolated Intel app: Developer ID
team `55DT52UQXE`, hardened runtime, deep signature validation, accepted notarization, a valid
stapled ticket, and Gatekeeper's `Notarized Developer ID` result. No local Developer ID private
identity or exported private key was needed. The original probe was the older `1fade4e` development
build and must never be published as the new release.

For a release, commit all source changes on main, set the intended version and create its
`desktop-v<version>` tag. Run `bash desktop/scripts/cloud-sign-mac.sh <version> <numeric-build>`
from that exact clean tagged commit. The script packages both Mac architectures, signs and uploads
each archive using the authorized Xcode account, polls only Apple's explicit processing state,
and refuses rejected/failed/unstapled/untrusted output. Its app ZIPs preserve stapled metadata;
DMGs are omitted until separately notarized. It never changes the installed application.

The ZIPs are only inputs to the separate cloud-release CI promotion gate: CI must verify the
signed apps, notarization, archive safety, exact release identity and rebuilt source contents,
then attest the manifest before publication. Do not manually publish the probe or bypass that
gate. Keep Xcode's local diagnostic logs private; only the verified installer ZIPs and public
release metadata are upload candidates. The cloud signing audit is on ops#61; the prepared CSR
remains a fallback and is not the cloud-managed signing key.

### Verified production releases

[Desktop 1.0.2](https://github.com/freeappstore-online/platform/releases/tag/desktop-v1.0.2), build
`2026112803`, is the current verified Mac/Linux release. Its
[promotion workflow](https://github.com/freeappstore-online/platform/actions/runs/46135844563)
passed all source, end-to-end, native packaging and release checks. The application source is
`6bcf052b307b5161556601c8fc24d436cb2d8e2a`; the trusted main verifier is
`48b6fe8982f08603345082d01c00f81ab667cb7c`. Both Mac ZIPs contain the padded full-resolution icon
and the corrected explanation of AI-provider data handling (#865).

After publication, all seven release assets were downloaded through their public URLs without
authentication. Their GitHub digests matched the bytes; installer hashes matched the signing
manifest. The three installers and manifest each passed cryptographic verification against the
downloaded Sigstore bundle, the exact `desktop-cloud-release.yml@refs/heads/main` workflow identity,
and `--deny-self-hosted-runners`. Mac/Linux updater SHA-512 values matched the downloads; both
`desktop-latest` updater aliases matched the versioned files. The local evidence is in
`build/public-desktop-1.0.2-verification/public-verification.json`.

The first verified production release was
[1.0.0](https://github.com/freeappstore-online/platform/releases/tag/desktop-v1.0.0), build
`2026112801`, from source `3fe64a94bd0d74cdd838441adc72ce8352b63b4a` and
[workflow 46121391118](https://github.com/freeappstore-online/platform/actions/runs/46121391118).
Version 1.0.1 stayed a private draft after its documentation-format check failed; the release gate
was not bypassed and its immutable source tag was not changed.

## Windows: Microsoft Store package

Microsoft signs APPX/MSIX submissions after certification. This avoids purchasing a signing
certificate and the SmartScreen reputation barrier for Store installations. The website can link
to the verified Store listing. This is different from submitting an EXE: EXE submissions still
require the publisher's Authenticode signature.

1. Use the existing Partner Center developer account, or finish registration at
   [Microsoft's developer portal](https://storedeveloper.microsoft.com/). The owner must complete
   any legal agreement or identity verification. Reserve the app name.
2. From the app's Product identity page, set these **public repository variables** exactly:
   `WINDOWS_STORE_IDENTITY_NAME` (Package/Identity/Name), `WINDOWS_STORE_PUBLISHER`
   (Package/Identity/Publisher), and `WINDOWS_STORE_PUBLISHER_DISPLAY_NAME`.
3. Advance `desktop/package.json` to the intended 1.x-or-later release before the first submission:
   Microsoft rejects a zero major version, and reserves the fourth package-version component for
   Store use. Production packaging refuses an incompatible version instead of silently rewriting it.
   Run `.github/workflows/desktop-store.yml`. It tests the code, builds an unsigned submission
   APPX with the real identity, and verifies its manifest and contents. The fourth package-version
   component stays zero; bump `desktop/package.json` for subsequent submissions.
4. Submit the APPX to Partner Center, complete the listing and restricted `runFullTrust`
   capability explanation, and pass certification. Explain the app windows, loopback AI bridge,
   user-authorized local file/CLI operations, and optional on-device narration accurately.
5. Verify an actual Store install, app launch, AI connections, contribution, startup controls,
   and an update that retains data. Only then add the real Store product URL to the website.

`desktop.yml` builds a package using an explicitly fake CI identity to catch packaging regressions.
That fixture uses version 1.0.0 and is never installed, uploaded as a public artifact, or submitted. Production packaging
refuses missing identity variables. The APPX workflow produces a submission artifact only;
it does not pretend that an unsigned package is a public installer or that certification is done.

Store builds use Microsoft Store for updates and Windows Settings for startup. They never
download or install the website's NSIS updates. A Store update must also be tested with saved
external AI-client launch configuration; packaged executable paths can change between versions.

[Microsoft's signing options](https://learn.microsoft.com/en-us/windows/apps/package-and-deploy/code-signing-options)
and [account setup](https://learn.microsoft.com/en-us/windows/apps/publish/partner-center/partner-center-developer-account?pivots=store-installer-msix)
document the Store signing route and free registration. Australian individuals are currently
outside Artifact Signing's eligible regions. Do not buy an OV/EV certificate expecting immediate
SmartScreen trust; Microsoft explicitly says even a newly signed app may need reputation.

## Direct Windows EXE and promotion evidence

The existing release path supports an already-issued exportable certificate via `WIN_CSC_LINK`
and `WIN_CSC_KEY_PASSWORD`, with `WINDOWS_SIGNING_THUMBPRINT` pinning its identity. This is not
a claim that a modern hardware/cloud-backed certificate can be exported. If direct EXE delivery
is chosen, select and integrate the actual provider's supported signing API/HSM before enabling
that path. No provider or purchase is provisioned by this change.

The default desktop release builds Mac and Linux; it does not require Windows signing credentials
while Windows takes the Store route. Set `DESKTOP_WINDOWS_DIRECT_ENABLED=true` only after the
direct Windows signing provider is provisioned. In that mode missing Windows credentials fail
before tagging. The manifest has `windows:null` when no direct EXE was built; no Windows evidence
is invented. The certificate workflow requires its five Mac/Linux artifacts; the cloud-managed
workflow requires the two notarized Mac ZIPs and Linux AppImage, with no unverified DMGs.

`verify-windows-release.ps1` checks both the application and installer for a trusted signature,
the expected certificate and a timestamp. It cannot prove SmartScreen reputation. After a real
signed release, verification must use the exact downloaded EXE on a clean supported Windows
machine, with normal Defender/SmartScreen settings and Mark of the Web preserved. Record its
SHA-256, release tag, publisher, Windows version, download source and observed installation result
on [#808](https://github.com/freeappstore-online/platform/issues/808). A bypassed warning fails.

`FreeAppStore-signing.json` binds the release version/tag/commit to all installer SHA-256s and the
platform verifier receipts. It is included in the signed provenance subjects. Its
`windows.smartScreenVerified` field is **false** by default even if an input receipt claims true.
The website must keep direct Windows downloads unavailable until a trusted promotion workflow
binds the reviewed Windows result to that exact EXE hash and re-attests the manifest. Do not edit
the flag by hand, accept a generic approval boolean, reuse a result for another build, or rebuild
the EXE after testing and retain the old result.

The download-page verification contract and store review are separate from npm audits and build
success. Keep [#857](https://github.com/freeappstore-online/platform/issues/857) open until actual
distribution and installer verification are complete.
