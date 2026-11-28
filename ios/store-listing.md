# iOS store listing

English (U.S.) copy for the existing **FreeAppStore Companion** record, App Store Connect ID `6840294127`, bundle `online.freeappstore.companion`. The shorter name FreeAppStore was unavailable. This file is submission material; it does not claim public App Store approval. Current distribution is internal TestFlight, **0.2.0 (55)**.

## Saved in App Store Connect — 2026-11-28

The 0.2.0 draft has build **55** attached, with the correct app icon. Promotional text, description, keywords, support/marketing URLs, copyright, subtitle, Productivity/Utilities categories and privacy-policy URL were saved.

The custom header from `brand/store-assets/app-store-header.png` persisted after navigation and rendered correctly in Apple's **Device Preview**, including the brand mark and headline. All four opaque RGB screenshots from `store-assets/listing/iphone-medium/` persisted and were accepted in the **iPhone with Dynamic Island (medium display)** slot. Their current saved order is **01, 04, 02, 03**. A brief drag-reorder attempt left the order unchanged; the four accepted assets were retained.

The TestFlight beta description below was saved and read back after a full page reload (811 characters). Build **0.2.0 (55)** received the What to Test text below (1120 characters), and App Store Connect confirmed **Saved**. The build remains assigned to the internal testing group. TestFlight's invitation screen says screenshots/category come from the latest version that reached **Ready for Distribution**; these draft listing assets are not yet evidence that they appear in tester invitations.

The App Store version remains **Prepare for Submission**. This metadata update did not submit App Review, change privacy declarations or establish physical installation/contribution. Public release and wider beta access remain separate work.

## App information

| Field | Value |
| --- | --- |
| Name | FreeAppStore Companion |
| Subtitle | Your apps, one place |
| Primary category | Productivity |
| Secondary category | Utilities |
| Price | Free |
| Marketing URL | https://freeappstore.online/install |
| Support URL | https://docs.freeappstore.online/devices/ |
| Privacy policy | https://freeappstore.online/privacy |
| Support email | support@freeappstore.online |
| Account deletion information | https://freeappstore.online/delete-account |
| Keywords | web,apps,favorites,shortcuts,tools,productivity,narration,audio,community,location |

Use the existing legal seller/copyright information from the account; do not invent a company name or reviewer contact. Productivity and Utilities were saved in App Store Connect; the other operational fields still need verification as part of release review.

## Promotional text

Find useful free web apps, keep your favourites close, and give back with optional on-device audio generation. Choose what your phone shares and when it contributes.

## Description

Your favourite FreeAppStore apps, closer at hand.

Browse a growing collection of free web apps for everyday tasks. Search the catalogue, explore categories, and save favourites for quick access. Recently opened apps are easy to find again. Open an app in your browser, or follow the built-in guide to add it to your Home Screen.

MAKE IT YOURS
Keep a personal shelf of favourites and recently used apps on this device. Browse the catalogue without signing in. Your shortcuts stay local, and each web app keeps its own data separately.

HELP CREATE NARRATION
With Contribute, you can help participating apps make audio, such as book narration. Choose the apps you want to support and download the optional voice model. Generation happens on your device; completed audio is uploaded to FreeAppStore for checking before it becomes available to others. See upcoming work, progress and the results of your contributions.

RUN ON YOUR TERMS
Set contribution preferences for charging, connectivity, battery level, quiet hours and daily limits. Use Run now while the app is open, or let iOS schedule background work when your conditions allow. Switch Contribute off at any time. iOS controls background timing, so continuous background generation is not guaranteed.

SHARE LOCATION ONLY WHEN YOU CHOOSE
Connect supported apps that need route recording, and enable location sharing separately for each one. See the sharing status, map and history, pause an app or pause everything, and turn sharing off when you are done. Location permission is optional and is not needed to browse the Store or generate audio.

FreeAppStore Companion is free to use. Browsing and opening web apps need an internet connection. Account connection is required for contributions and location sharing. Audio generation requires an additional voice-model download of approximately 350 MB and available device storage. Apps and available contribution jobs can change over time.

## TestFlight beta description

FreeAppStore Companion puts free web apps and useful native features together on your iPhone. Browse the catalogue, save favourites and find recently opened apps. Apps open in your browser, with a guide for adding them to your Home Screen.

Optional Contribute lets your device generate narration for participating apps. Choose apps, download the voice model, and watch progress and upcoming jobs. Run now works while the app is open; iOS schedules background work when your configured conditions allow. Optional location sharing helps supported apps record routes with your permission and per-app controls.

Browsing does not require an account. Contributions and location sharing require connecting your FreeAppStore account. This beta is for testing; available jobs depend on what app publishers have queued.

## What to test — 0.2.0 (55)

1. Browse and search the Store. Open an app, save a favourite, restart FreeAppStore, and check that your shortcuts remain.
2. Open an app's page and check the Add to Home Screen guidance. Web apps open in the browser.
3. If you want to contribute, connect your account, choose an app in Contribute settings, and download the voice model on Wi-Fi. Check the upcoming-work list and tap Run now while keeping FreeAppStore open. Look for the upload and its eventual result in Activity. An empty queue is a valid state.
4. Check charging, network, battery, quiet-hours and daily-limit controls. Off should stop contribution. Background execution is scheduled by iOS and may not start immediately.
5. If you use a supported route-recording app, enable sharing only for that app. Check pause/resume and the map/history. Do not enable location just to test the Store or Contribute.
6. Try larger text in iOS Settings. Report clipped controls, unreadable text, crashes or incorrect contribution results through TestFlight, including the app version and the relevant screen. Do not include account tokens or private location data.

## App Review notes

FreeAppStore Companion is a native catalogue and optional device-services companion. Catalogue apps open externally in the system browser; it does not install executable native apps or download executable code. The optional downloaded voice model is data used by the bundled inference library.

**Without signing in:** launch the app, browse/search the Store, open a detail page, add/remove a favourite, and follow the Home Screen guide. Close and reopen the app to confirm shortcuts persist.

**Optional account features:** Sharing and Contribute offer account connection. Supply working reviewer access privately in App Store Connect before submission; do not put passwords, pairing codes or personal account details in this repository. A signed-in session is required to review these features end to end. The app can also connect using a short-lived pairing code from an already signed-in FreeAppStore device or account console.

**Contribute:** select an app, approve its contribution disclosure, download the approximately 350 MB voice model, and use Run now. Keep the app visible. When work is available, it claims publisher-provided narration jobs, generates audio locally and uploads results for verification. The Activity screen shows progress and outcomes; the upcoming list shows up to 100 awaiting jobs. No microphone recording occurs. If no eligible jobs exist, the queue is empty; a reviewer must not be promised a manufactured or permanent production backlog. Arrange actual reviewable work before submission if a complete generation demonstration is needed.

**Background processing:** automatic contributions use iOS background scheduling and the user's configured conditions. A foreground Run now stops when the app leaves the screen. Continuous background execution is not promised. Background location is a separate, optional feature for supported route-recording apps, with system permission and explicit per-app consent. It is not needed for audio generation.

**Data and deletion:** favourites and recent apps are local. Contribution uploads and their diagnostic/quality records are linked to the connected account. Enabled location sharing sends location updates for the apps selected by the user. Settings provides Manage account, Delete account, privacy information and Sign out. Delete account opens the authenticated account-deletion flow; signing out revokes this device's connection. See the privacy policy for retention and deletion details.

## Screenshot plan and capture rules

Use real, clean simulator captures of this app. Do not show private profiles, tokens, pairing codes, real routes, invented completed contributions or fictitious production queues. Public catalogue entries and locally selected favourites are suitable. Record any simulator-only local shortcut fixture beside the captures. Keep the pixels of the actual app visible; decorative captions must describe demonstrated behavior.

Suggested sequence: Store overview; favourites and recent apps; an app detail page; Home Screen guidance. A signed-out Contribute explanation may be used if it adds useful information, but it must not be presented as a completed generation run. Capture signed-in contribution controls only with a permitted, documented review account or clearly documented offline fixture; do not borrow a personal account for marketing screenshots.

As checked on 2026-11-28, [Apple's screenshot specifications](https://developer.apple.com/help/app-store-connect/reference/app-information/screenshot-specifications) require an iPhone Dynamic Island medium-display set. Use **1206 × 2622** (iPhone 16 Pro) and optional **1320 × 2868** large-display coverage. Use PNG/JPEG without transparency, one to ten images per set. App Store Connect's actual upload validation remains authoritative if its device slots change.

The current release is **iPhone-only**: both the uploaded 0.2.0 (55) IPA and the capture build declare `UIDeviceFamily=[1]`, matching `TARGETED_DEVICE_FAMILY: "1"` in `ios/project.yml`. It can run in iPhone compatibility mode on iPad, but must not be presented as a native iPad layout. A 13-inch iPad screenshot set becomes required if a future build adds native iPad support; 2064 × 2752 is an accepted portrait size. A compatibility-mode screenshot is not evidence of that support.

## Remaining submission work

- Optionally reorder the accepted screenshots to 01, 02, 03, 04. The current 01, 04, 02, 03 order is usable and all images were visually verified.
- Complete the age-rating, content-rights, export-compliance, accessibility and regional availability forms with answers matching the current app. Do not claim accessibility support without the relevant verification.
- Complete App Privacy answers against the app/server behavior and privacy manifest; optional account, generated audio, location, performance and diagnostic collection must not be described as no collection.
- Supply private reviewer access and the account holder's real review contact. Check any agreements or regional trader declarations the account requires.
- For wider TestFlight availability, create an external testing group and complete Apple's beta review. For public App Store availability, submit the version for App Review and verify approval/release separately. Internal TestFlight availability alone completes neither step.

Apple field definitions: [platform version information](https://developer.apple.com/help/app-store-connect/reference/app-information/platform-version-information).
