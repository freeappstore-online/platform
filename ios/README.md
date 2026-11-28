# FreeAppStore iOS companion

Swift + SwiftUI client of the `/v1/native/*` API: Store, location for the FAS apps you enable (kept recording with the iPhone locked), Contribute and Account. Ported from the PAS iOS companion (`proappstore-online/platform` `ios/`). User guide: [docs/devices.md](../docs/devices.md); protocol: [docs/native-companion.md](../docs/native-companion.md).

## Build and test

Prerequisites: Xcode 16 or later. [XcodeGen](https://github.com/yonaskolb/XcodeGen) **2.45.4** (the version `.github/workflows/ios.yml` pins; others generate different output) only when `project.yml` changes; the generated `FreeAppStore.xcodeproj` is committed.

```sh
cd ios && xcodegen generate && git diff --exit-code -- FreeAppStore.xcodeproj   # project matches project.yml
cd ..
xcodebuild -project ios/FreeAppStore.xcodeproj -scheme FreeAppStore -destination 'platform=iOS Simulator,name=iPhone 16' -derivedDataPath build/ios test CODE_SIGN_IDENTITY=-
xcodebuild -project ios/FreeAppStore.xcodeproj -scheme FreeAppStore -destination 'generic/platform=iOS' -derivedDataPath build/ios build CODE_SIGNING_ALLOWED=NO
```

Tests are ad-hoc signed (`CODE_SIGN_IDENTITY=-`) because an unsigned simulator host has no Keychain access. The device build is unsigned.

Bundle ID: `online.freeappstore.companion` (`FAS_BUNDLE_ID` in `Config/Base.xcconfig`). iOS 17 minimum, Swift 5 language mode. No package manager. The one binary dependency is sherpa-onnx (Kokoro TTS for Contribute, #733): the scheme's build pre-action runs `scripts/fetch-sherpa-onnx.sh`, which downloads the pinned release xcframework into the untracked `Vendor/` once and refuses it unless its SHA-256 matches. A build without network access needs `Vendor/SherpaOnnxC.xcframework` already in place.

`ContributeTests.testRealKokoroNarratesAndEncodes` runs the real model when `TEST_RUNNER_FAS_KOKORO_ARCHIVE` names a local copy of the pinned `kokoro-multi-lang-v1_0.tar.bz2`; otherwise it is skipped.

Phone installs and updates use **TestFlight**. The first internal release, **FreeAppStore Companion 0.2.0 (55)**, is available to the invited owner account. Builds can use the existing Xcode account with a verified CI archive, or the manually dispatched signing job in `.github/workflows/ios.yml` once its credentials are provisioned. See [TestFlight setup, release and verification](release/README.md). Simulator and unsigned CI builds above remain development checks; they are not distribution releases. `DEVELOPMENT_TEAM` remains local/CI configuration and is not committed.

## Version and branding

`Config/Version.xcconfig` is the only version source: `MARKETING_VERSION`, `CURRENT_PROJECT_VERSION`, `FAS_COMMIT` and `FAS_DEV_BUILD`. `Info.plist` reads them; CI passes the workflow run number as the build number, the short SHA as the commit and `FAS_DEV_BUILD=NO`. A local build shows build `dev` and its commit, which the scheme's pre-action `scripts/write-commit.sh` writes to the untracked `Config/Commit.xcconfig`. The About section displays them with a "What's new" link; releases: [docs/versioning.md](../docs/versioning.md).

`Assets.xcassets` holds the app icon, `AccentColor` (the app tint, kit accent `#2563eb` / dark `#60a5fa`) and `LaunchBackground` (design-system `--paper`, `#f8fafc` / `#0f172a`). `AppIcon-1024.png` is the brand kit's maskable icon composition (the one behind `icon-512.png`) rendered at 1024×1024 with the kit's own `generate.py` and flattened to RGB, because App Store icons must have no alpha channel. Never redraw it: regenerate from the kit and register it in the workspace `brand/destinations.json` (`renders`).

The fixed production API origin is `https://api.freeappstore.online`; the app exposes no server URL or token field. The `freeappstore://native/…` return URI contains no credentials and never grants permission.
