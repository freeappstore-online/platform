# TestFlight distribution

Issue [#863](https://github.com/freeappstore-online/platform/issues/863), part of [#857](https://github.com/freeappstore-online/platform/issues/857).

Phone installs and updates use TestFlight. Do not use direct Xcode/devicectl installs as a substitute for this release path. This workflow does not submit a production App Store version or create an external/public beta invitation.

## One-time setup

1. In App Store Connect, create or find **FreeAppStore**, bundle ID `online.freeappstore.companion`, under the intended paid Apple team. Record its numeric app ID.
2. Create an **internal** TestFlight group and invite the intended App Store Connect user (the Apple account used in TestFlight on the phone). Record the group ID. A group with no testers fails preflight. Internal testing is the initial private distribution channel; broader public access requires an external group and Apple's beta review.
3. Issue an Apple Distribution certificate and App Store Connect distribution provisioning profile for this exact bundle ID. Export the certificate with its private key as a password-protected P12. The profile must not list devices, permit debugging, or be an enterprise profile.
4. Create an App Store Connect API key with access to this app and the build/TestFlight operations used below. Keep the key's scope as narrow as Apple supports. Accept any outstanding Apple agreements as the Account Holder. Do not send keys in chat.
5. Track credential provisioning in [ops#62](https://github.com/serge-ivo/ops/issues/62), which declares these **fas** keys with consumer `github-repo-secret: freeappstore-online/platform`, then place them with `ops put fas KEY`:

   - `IOS_DIST_CERT_P12_BASE64`
   - `IOS_DIST_CERT_PASSWORD`
   - `IOS_APPSTORE_PROFILE_BASE64`
   - `ASC_API_KEY_ID`
   - `ASC_API_ISSUER_ID`
   - `ASC_API_KEY_P8_BASE64`

6. Set repository variables `IOS_TEAM_ID`, `ASC_APP_ID`, and `ASC_BETA_GROUP_ID`. The local development team currently used is `55DT52UQXE`; verify the distribution app/profile belong to the same team before setting it.

Do not reuse PAS profiles (their bundle ID differs). The old statement in desktop issue #807 that PAS ASC material was available is not evidence: on 2026-11-28, all six PAS ASC/distribution entries in ops#58 were still metadata-only and `ops get` confirmed no stored values. Inspect the current store/provider again when provisioning.

## Release

```sh
gh workflow run ios.yml --repo freeappstore-online/platform --ref main -f testflight=true
```

The main-only job waits for simulator tests, unsigned device compilation, and release-tool tests. It uses the newest stable Xcode on `macos-26` and rejects Xcode older than 26, matching [Apple's SDK upload requirement](https://developer.apple.com/news/upcoming-requirements/?id=04282026a).

Before signing, it verifies the app's bundle ID, internal group ownership and testers, then picks a build number higher than all existing builds of this marketing version. Signing secrets are exposed only to the consuming steps. The signing script uses a temporary runner keychain and restrictive files, validates the profile, verifies the archived signature and entitlements, uploads, and removes signing material on exit. No signing material or archive is uploaded as a GitHub artifact.

After upload, `testflight.mjs` waits up to 30 minutes for Apple processing, adds the build to the configured group, and checks group membership, nonempty testers and `IN_BETA_TESTING`. Failed processing, missing export compliance, or group assignment does not produce a successful release result. If Apple processing takes longer, inspect the existing build rather than blindly uploading duplicates. A successful API check establishes availability to the group; verify installation separately in TestFlight on the intended iPhone.

## Privacy manifest

`FreeAppStore/PrivacyInfo.xcprivacy` describes optional account/pairing, enabled location sharing, generated audio, user-submitted content, and generation performance/diagnostics. There are no tracking domains. Keep App Store Connect privacy answers aligned with the app and server behavior; generated narration is audio data but the app does not record microphone audio.

Required-reason declarations reflect install-guide preferences (UserDefaults), model-download disk checks, in-app elapsed stage timings, and app-container file metadata. The embedded SherpaOnnxC framework receives its own reviewed file-metadata declaration from `ios/Privacy/`; both manifests are required in the archive. See [Apple's required-reason API list](https://developer.apple.com/documentation/bundleresources/app-privacy-configuration/nsprivacyaccessedapitypes/nsprivacyaccessedapitype). An app privacy manifest does not replace any required manifest in a third-party framework.

## Local checks

```sh
node --test ios/release/testflight.test.mjs
python3 -m unittest discover -s ios/release -p '*_test.py'
shellcheck ios/release/upload.sh
actionlint .github/workflows/ios.yml
```

## First release using an existing Xcode account

On 2026-11-28, the signed-in Xcode account on the maintainer Mac successfully archived and exported this app with **Apple Distribution** signing for team `55DT52UQXE`. The exported profile was an App Store profile (`get-task-allow=false`, beta reports enabled, no device list), and deep/strict signature verification passed. This establishes account-backed distribution signing access even though CI secrets are absent. It does not establish an uploaded TestFlight build. The local Xcode was 16.0, below Apple's current SDK minimum.

For this situation, dispatch the credential-free archive path:

```sh
gh workflow run ios.yml --repo freeappstore-online/platform --ref main -f archive_for_local_upload=true
```

After tests and archive generation pass, inspect the run's `headSha`, `headBranch`, event and conclusion with `gh run view`. Download only that run's `fas-ios-archive-RUN_ID` artifact. The artifact is retained for one day, contains no signing material, and cannot install on a phone. Before signing:

1. Verify `archive.sha256` against the downloaded zip, then unpack it in an isolated build directory.
2. Run `python3 ios/release/archive-manifest.py verify ARCHIVE_PATH archive-input.json EXPECTED_FULL_SHA EXPECTED_RUN_NUMBER EXPECTED_MARKETING_VERSION`. The expected SHA/build must come from the inspected GitHub run, and marketing version from `ios/Config/Version.xcconfig` at that exact commit, not the artifact itself. This checks bundle ID, version/build, commit, production flag, supported SDK and both privacy manifests.
3. Use `xcodebuild -exportArchive` with the existing Xcode account, `-allowProvisioningUpdates`, `method=app-store-connect`, `signingStyle=automatic`, the verified team, and `destination=upload`. Keep automatic version/build renumbering off. If Apple rejects a reused build number, create a fresh archive; do not install it directly.
4. Verify Apple processing and group/tester availability in App Store Connect (or the API helper when its key is available). An upload exit code is not enough to claim TestFlight availability.

An older local Xcode may refuse to export a newer SDK archive; if so, use a supported local Xcode or the fully configured CI signing job above. Never bypass signature or SDK checks. Creating/replacing identities through the existing Xcode account is tracked in [ops#62](https://github.com/serge-ivo/ops/issues/62); no private keys are extracted for this path.
