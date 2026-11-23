# FreeAppStore iOS companion

Swift + SwiftUI client of the `/v1/native/*` API that keeps recording location with the iPhone locked, for the FAS apps you enable. Ported from the PAS iOS companion (`proappstore-online/platform` `ios/`).

## Build and test

Prerequisites: Xcode 16 or later. [XcodeGen](https://github.com/yonaskolb/XcodeGen) **2.45.4** (the version `.github/workflows/ios.yml` pins; others generate different output) only when `project.yml` changes; the generated `FreeAppStore.xcodeproj` is committed.

```sh
cd ios && xcodegen generate && git diff --exit-code -- FreeAppStore.xcodeproj   # project matches project.yml
cd ..
xcodebuild -project ios/FreeAppStore.xcodeproj -scheme FreeAppStore -destination 'platform=iOS Simulator,name=iPhone 16' -derivedDataPath build/ios test CODE_SIGN_IDENTITY=-
xcodebuild -project ios/FreeAppStore.xcodeproj -scheme FreeAppStore -destination 'generic/platform=iOS' -derivedDataPath build/ios build CODE_SIGNING_ALLOWED=NO
```

Tests are ad-hoc signed (`CODE_SIGN_IDENTITY=-`) because an unsigned simulator host has no Keychain access. The device build is unsigned.

Bundle ID: `online.freeappstore.companion` (`FAS_BUNDLE_ID` in `Config/Base.xcconfig`). iOS 17 minimum, Swift 5 language mode. No third-party packages.

Device installs are signed in Xcode with your own team. `DEVELOPMENT_TEAM` is never committed: set it in Signing & Capabilities or in an untracked `Config/Local.xcconfig` (which may also override `FAS_BUNDLE_ID`). Distribution is developer installation only; there is no TestFlight or App Store build.

## Version and branding

`Config/Version.xcconfig` is the only version source: `MARKETING_VERSION`, `CURRENT_PROJECT_VERSION` and `FAS_COMMIT`. `Info.plist` reads all three; CI passes the workflow run number as the build number and the short SHA as the commit, local builds show build `1` and commit `dev`. The About section displays them.

`Assets.xcassets` holds the app icon, `AccentColor` (the app tint, kit accent `#2563eb` / dark `#60a5fa`) and `LaunchBackground` (design-system `--paper`, `#f8fafc` / `#0f172a`). `AppIcon-1024.png` is the brand kit's maskable icon composition (the one behind `icon-512.png`) rendered at 1024×1024 with the kit's own `generate.py` and flattened to RGB, because App Store icons must have no alpha channel. Never redraw it: regenerate from the kit and register it in the workspace `brand/destinations.json` (`renders`).

The fixed production API origin is `https://api.freeappstore.online`; the app exposes no server URL or token field. The `freeappstore://native/…` return URI contains no credentials and never grants permission.
