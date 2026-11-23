# FreeAppStore Android companion

Native **Kotlin + Jetpack Compose + Material 3** app for FAS app users. Port of the PAS Android companion
(`proappstore-online/platform` `android/`), adapted to FAS (#621). No WebView, no image library and no developer
tools. Protocol and deep links: [docs/native-companion.md](../docs/native-companion.md).

- **Sharing tab:** sign in through the system browser (pairing at `api.freeappstore.online/v1/native/*`, return via
  `freeappstore://native/connected`), per-app disclosure and consent, background location foreground service with
  Pause all, per-app pause, a private SQLite upload queue and a Keystore-protected device credential.
  `freeappstore://native/apps/<id>` opens that app's disclosure; it never grants anything by itself.
  The control room (ported from PAS #638, #649) shows per-app state, shared time today, last upload, waiting to
  upload, sync health and this phone's location, battery and recorder status, an overview track and a per-app
  session timeline drawn with Compose `Canvas` (no map tiles), and an activity log, all from a 30-day on-device
  history that never leaves the phone.
- **Settings tab:** account, location permission, expiry note and Reconnect, Clear sharing history, Disconnect, About.
- **Store tab:** the public catalogue from `https://freeappstore.online/registry.json`, cached on the phone and
  revalidated with `If-None-Match` by a credential-free client that refuses redirects (`FasApi` stays limited to
  `/v1/native/`). Featured, Yours, category rows, search, All apps and an app page. Icons are the registry's emoji on
  its `iconBg`. **Open** goes to `<appUrl>/?install=1`, where the host shows an Install button (`workers/host`).

## Build

JDK 17+ and Android SDK platform 36. Set `ANDROID_HOME` or put `sdk.dir=/path/to/sdk` in an untracked
`local.properties`.

```sh
./gradlew :app:assembleDebug :app:testDebugUnitTest :app:lintDebug
# With an emulator or device attached:
./gradlew :app:connectedDebugAndroidTest
```

Debug APK: `app/build/outputs/apk/debug/app-debug.apk`. Package `online.freeappstore.companion`, Android 10 (API 29)
minimum, compile and target API 36. CI: `.github/workflows/android.yml`.

Release signing and Google Play publishing are not set up yet: they need secrets and a Play listing.
