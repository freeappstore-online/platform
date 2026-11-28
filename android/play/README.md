# Android Play listing assets

English listing preparation for `online.freeappstore.companion`, tracked in platform #864. Files here are reviewable inputs; preparing them does not upload or publish a store listing.

## Copy and graphics

- `en-US/title.txt`, `short-description.txt`, `full-description.txt`: Play listing copy. The description distinguishes browser apps, local shortcuts, optional contribution and optional background location.
- `en-US/images/featureGraphic.png`: 1024×500 opaque marketing graphic. It uses the canonical outlined wordmark, blue palette and Manrope; it is not an app screenshot.
- `../../brand/native-assets/play-icon-512.png`: canonical 512×512 Play icon, managed by the shared native brand exporter.
- `en-US/images/listingPhoneScreenshots/`: final captioned store exports. Their manifest binds every frame to the preserved raw screenshot hash. Only these final frames are uploaded as phone screenshots.
- `en-US/images/phoneScreenshots/`: unmodified screenshots from the actual app on a dedicated, signed-out Android emulator. The capture manifest records source, timestamp, hash and alt text. No fabricated jobs, activity, location tracks or account details.

Re-render the feature graphic from the repository root:

```sh
node android/play/design/render-feature.mjs
```

The vendored Manrope font is distributed under its included SIL Open Font License. Upstream: https://github.com/google/fonts/tree/main/ofl/manrope . Branding geometry comes unchanged from `brand/assets/wordmark-dark.svg`.

## Repeat a screenshot session

1. Create a dedicated AVD named `fas_play_listing` using Android API 34 Google APIs x86_64; set its display to 1080×1920 at 420 dpi. Do not use an emulator containing a personal account.
2. Build the debug APK with `ANDROID_HOME` pointing to your SDK: `cd android && ./gradlew :app:assembleDebug`.
3. Install the APK only on that emulator. Never use this workflow to sideload onto a physical phone; user installations go through Google Play.
4. Open and navigate the actual app through CUA. Remain signed out. Browse the public catalogue and save a small selection of real apps as favourites using the visible controls. Capture Store, quick access, one app detail, and the optional contribution or sharing explanation. Avoid a keyboard, dialog, loading spinner, clipped text, or personal data in a final screenshot.
5. Export the current screen without changing its pixels:

```sh
node android/play/capture.mjs emulator-5554 01-store 'Browse web apps in the FreeAppStore catalogue.'
```

The helper only reads the named emulator and runs `screencap`; it sends no taps, input, UIAutomator commands or account requests. It refuses physical serials, other AVDs, oversized files, or unexpected dimensions. Inspect every image before selecting it for the listing.

6. Generate and visually review the captioned frames with the shared native screenshot exporter; retain the original pixels in `phoneScreenshots/`. Run `node android/play/validate-assets.mjs` to check copy limits, icon/graphic formats, screenshot dimensions and hashes, and write `export-manifest.json`. Upload only those reviewed files in Play Console → Grow users → Store presence → Main store listing. A listing save is separate from production-release approval and policy declarations.

## Current official requirements

Checked against Google's [preview asset requirements](https://support.google.com/googleplay/android-developer/answer/9866151) on 2026-11-28: phone screenshots are 2–8 PNG/JPEG images, each side 320–3840 px and each file at most 8 MB; Google specifies portrait 9:16 or landscape 16:9. This set targets native 1080×1920 portrait. The feature graphic is 1024×500 JPEG or 24-bit PNG without alpha. The Play icon is 512×512 PNG, at most 1024 KB. Short description limit: 80 characters. Text may be localized later; never claim working jobs or contributions that have not happened.

## Publisher API handoff

The existing default locale is `en-GB`. The prepared copy also supplies `en-US`; both use the same reviewed English text and graphics. Other locales, videos, tablet images and release tracks are preserved.

Read the ops secret-management skill and `~/dev/ops/AGENTS.md` first. The client consumes credentials only from stdin, keeps them in process memory and never prints credentials or raw API error bodies:

```sh
~/dev/ops/bin/ops get fas GOOGLE_PLAY_SERVICE_ACCOUNT_JSON | node android/play/publish-listing.mjs inspect
```

After the export manifest and actual images have been reviewed, the authorized publishing step is:

```sh
~/dev/ops/bin/ops get fas GOOGLE_PLAY_SERVICE_ACCOUNT_JSON | node android/play/publish-listing.mjs apply
```

The client checks every reviewed file hash before opening an edit, refuses to overwrite different nonempty copy or image sets, verifies Google's uploaded image digests, validates the edit, commits and reads everything back through a fresh edit. No release track is changed. `--defer-review` is available only when Google requires saving changes without submitting them for review; those changes remain pending in Play Console. A successful API commit does not mean public production availability or review approval.

### Android Studio capture recovery

When the standalone emulator is not addressable through CUA, open Android Studio and use the Running Devices pane (the project can remain in Safe Mode). This dedicated emulator was successfully attached by starting it with the official embedded flags and disabling its problematic Vulkan startup path:

```sh
"$ANDROID_HOME/emulator/emulator" -avd fas_play_listing -qt-hide-window -grpc-use-token -no-snapshot -no-audio -gpu host -feature -Vulkan
```

Navigate the embedded phone exclusively through CUA, then use the read-only capture helper. The capture machine was heavily loaded; wait for `sys.boot_completed=1` before starting. Shut down only this dedicated emulator after capture to release host resources. Do not disable signing, authentication, or app permissions to obtain screenshots.
