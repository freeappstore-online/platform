# Versioning the desktop, Android and iOS apps

Each app has one committed version, numbers every CI build, and says so when a build is a local one (#832).

| App | Version file | Build number | Tag |
|---|---|---|---|
| Desktop (`desktop/`) | `desktop/package.json` `version` | release workflow run number (`FAS_BUILD_NUMBER`) | `desktop-v<version>` |
| Android (`android/`) | `android/version.properties` `versionName` | `versionCode` from `ANDROID_BUILD_NUMBER` (run number, or above every Play track) | `android-v<version>` |
| iOS (`ios/`) | `ios/Config/Version.xcconfig` `MARKETING_VERSION` | `CURRENT_PROJECT_VERSION` (run number) | `ios-v<version>` |

Versions are semver (`0.3.0`). The version file always holds the latest released version; a release bumps it. Every
build also carries its build number and the short commit:

- a CI build shows `0.3.0 (57, abc1234)`;
- a local build shows `0.3.0 (dev, abc1234)`. It never claims a real build number.

That label is what each app shows in About (desktop: the Account page; Android and iOS: Settings) next to a
**What's new** link to the version's GitHub release. It is also the `appVersion` in every Contribute attempt record
(#827).

## Where the numbers come from

- **Desktop.** `pnpm build` runs `desktop/scripts/build-info.mjs`, which writes `dist/build-info.json` with the
  commit and `FAS_BUILD_NUMBER` (only `desktop-release.yml` sets it, otherwise `dev`). The version is `package.json`'s,
  through `app.getVersion()`.
- **Android.** `app/build.gradle.kts` reads `version.properties`. CI sets `ANDROID_BUILD_NUMBER` (the debug build to
  the run number, the release job to a code above every Play track); without it the build is a dev build
  (`BuildConfig.FAS_DEV_BUILD`). The commit comes from `git rev-parse` at build time.
- **iOS.** `Config/Version.xcconfig`; CI passes `CURRENT_PROJECT_VERSION`, `FAS_COMMIT` and `FAS_DEV_BUILD=NO`. A local
  build keeps build `1`, shown as `dev`, and gets its commit from the scheme pre-action `scripts/write-commit.sh`.

## Cutting a release

Run the app's release workflow on `main` with the new version. It writes the version to the app's version file in a
`release: <app> <version>` commit on `main`, tags that commit `<app>-v<version>` and publishes a GitHub release whose
notes list the app's commits since its previous tag (`scripts/app-release.sh notes`). It refuses a version lower than
the committed one or a tag that exists. The committed version may be released as it is (a first release).

```sh
# Desktop: also builds the installers and refreshes desktop-latest (the download page's links).
gh workflow run desktop-release.yml --repo freeappstore-online/platform --ref main -f version=0.3.0

# Android: then runs android.yml on the release tag, which builds the signed release (and uploads it to Play's internal track
# when ANDROID_PLAY_PUBLISH_ENABLED is set and the signing secrets exist; android/README.md, Release).
gh workflow run app-release.yml --repo freeappstore-online/platform --ref main -f app=android -f version=0.2.0

# iOS: then runs ios.yml on the release tag. There is no TestFlight upload until signing exists.
gh workflow run app-release.yml --repo freeappstore-online/platform --ref main -f app=ios -f version=0.2.0
```

A desktop tag pushed by hand (`git tag desktop-v0.3.0 && git push origin desktop-v0.3.0`) also builds, but only if
`desktop/package.json` at that commit already says `0.3.0`. Running `desktop-release.yml` with an existing version
rebuilds that tag.

To see what a release would contain before cutting it: `scripts/app-release.sh notes <app> HEAD`.
