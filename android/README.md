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

- **Contribute tab** (#731): opt in per app to generate its published jobs (narration) on the phone with Kokoro via
  sherpa-onnx, then upload them for the server to verify. The voice model downloads on demand (pinned URL and SHA-256,
  no-backup storage, deletable); WorkManager runs it while charging on an unmetered network by default, with a
  foreground notification. Protocol: [docs/native-companion.md](../docs/native-companion.md#contribute-android-731).

## Build

JDK 17+ and Android SDK platform 36. Set `ANDROID_HOME` or put `sdk.dir=/path/to/sdk` in an untracked
`local.properties`.
The first build downloads the pinned sherpa-onnx AAR (52 MB) into `app/libs/` (untracked) and checks its SHA-256.

```sh
./gradlew :app:assembleDebug :app:testDebugUnitTest :app:lintDebug
# With an emulator or device attached:
./gradlew :app:connectedDebugAndroidTest
```

Debug APK: `app/build/outputs/apk/debug/app-debug.apk`. Package `online.freeappstore.companion`, Android 10 (API 29)
minimum, compile and target API 36. CI: `.github/workflows/android.yml`.

## Release

Ported from the PAS pipeline (#651). On a push to `main`, `.github/workflows/android.yml` runs a `release` job after
`build`: it restores the upload keystore into a private temp dir, builds `:app:assembleRelease :app:bundleRelease
:app:lintRelease` with `scripts/build-android-release.sh`, checks that the APK and AAB signer matches the pinned
`android/signing/upload-certificate.pem`, and keeps the APK, AAB, R8 `mapping.txt` and `release.json` as an artifact.
Pull requests never get signing or Play credentials.

- **Skipped without secrets.** A `release-gate` job checks for the four `ANDROID_UPLOAD_*` secrets. Until they exist,
  `release` is skipped and the run stays green.
- **Unsigned releases are refused.** `assembleRelease` and `bundleRelease` fail without the signing env with
  "Release signing is required. Use scripts/build-android-release.sh with FAS upload credentials." There is no
  debug-key fallback.
- **Play upload.** The upload is off until requested. It runs on a manual run with `publish=true`, or on every `main`
  push once the repo variable `ANDROID_PLAY_PUBLISH_ENABLED=true` is set. The track defaults to **`internal`**
  (manual input, or the repo variable `ANDROID_PLAY_TRACK`). `scripts/android-play-release.mjs next-code` picks a
  versionCode above every Play track, bundle and APK, and never below `version.properties` or the run number. The
  publish step uploads, validates, commits, then verifies the track through a fresh edit. Track acceptance is not
  Google review approval.

```sh
gh workflow run android.yml --repo freeappstore-online/platform --ref main                    # signed artifacts only
gh workflow run android.yml --repo freeappstore-online/platform --ref main \
  -f publish=true -f track=internal -f status=draft                                         # first API upload
```

Repo-level secrets (the repo is private, so org secrets don't reach it). The source of truth is `~/dev/ops`, project `fas`:

| Secret | Purpose |
|---|---|
| `ANDROID_UPLOAD_KEYSTORE_BASE64` | Dedicated FAS PKCS12 upload keystore, base64 |
| `ANDROID_UPLOAD_KEYSTORE_PASSWORD` | Store password |
| `ANDROID_UPLOAD_KEY_ALIAS` | Upload key alias |
| `ANDROID_UPLOAD_KEY_PASSWORD` | Private-key password |
| `GOOGLE_PLAY_SERVICE_ACCOUNT_JSON` | FAS Play publisher service-account key (only needed to publish) |

### One-time human setup

1. **Upload key.** Create a dedicated FAS upload key. Never reuse the PAS or HeartFull key. For example:
   `keytool -genkeypair -storetype PKCS12 -keystore fas-upload.p12 -alias fas-upload -keyalg RSA -keysize 4096
   -validity 10000 -dname "CN=FreeAppStore"`. Keep the keystore out of the repo.
2. **Pin the certificate.** Export the public certificate and commit it as `android/signing/upload-certificate.pem`:
   `keytool -exportcert -rfc -keystore fas-upload.p12 -alias fas-upload > android/signing/upload-certificate.pem`.
   The release script refuses to run without it.
3. **Store the secrets in ops.** Open an issue in `serge-ivo/ops` (every secret change is tracked there). Add the five
   entries to `inventory.yaml` under `fas:`, each with `consumers: [github-repo-secret: freeappstore-online/platform]`.
   Then run `~/dev/ops/bin/ops put fas <KEY>` for each one. For the keystore, use the output of `base64 < fas-upload.p12`.
   `ops put` encrypts each value and places it as a repo secret. See `~/dev/ops/AGENTS.md`.
4. **Play Console app.** Create the app with package `online.freeappstore.companion` (#654). The Play API cannot create
   an app, so the **first upload must be manual**. Run the workflow (signed artifacts only), download
   `app-release.aab` from the run's artifact, upload it to the internal track in Play Console, and enrol in **Play App
   Signing**. The pinned certificate is the *upload* certificate. Google's app-signing certificate is different.
5. **Publisher service account.** Create a Google Cloud service account for FAS publishing and store its JSON key as
   `GOOGLE_PLAY_SERVICE_ACCOUNT_JSON` (step 3). In Play Console → Users and permissions, invite it for this app only,
   with release permissions for testing tracks (and production only when ready).
6. **Turn on uploads.** Do a manual run with `publish=true track=internal status=draft`. When that works, set the repo
   variable `ANDROID_PLAY_PUBLISH_ENABLED=true` so `main` pushes publish to `internal` with `completed` status.

Do not change the package or replace the upload key after the first upload.
