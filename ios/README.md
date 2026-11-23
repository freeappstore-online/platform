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

Bundle ID: `online.freeappstore.companion` (`FAS_BUNDLE_ID` in `Config/Base.xcconfig`). For a device install, set `DEVELOPMENT_TEAM` (and, if needed, a unique `FAS_BUNDLE_ID`) in Signing & Capabilities or an untracked `Config/Local.xcconfig`. Developer installation from Xcode only; no TestFlight or App Store build.
