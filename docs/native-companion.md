# Native companion

The FreeAppStore phone app keeps collecting location with the screen locked and
hands it to the FAS apps you turn on. Decision record: [ADR-002](https://github.com/freeappstore-online/platform/blob/main/docs/adr/002-native-companion.md).

## Recipients

| App | Capability | Purpose |
|---|---|---|
| Run | `location.background` | Keep recording runs and walks while the phone is locked or Run is closed. |

The list lives in `packages/backend/src/lib/native-companion.ts`. Each entry's
contract version is a hash of its wording, so any change to the disclosure
revokes every existing grant and users consent again.

## API (base `https://api.freeappstore.online/v1`)

Device side, `Authorization: Bearer ndev_…`:

| Call | Body | Response |
|---|---|---|
| `POST /native/auth/start` | `{ challenge: sha256hex(verifier), label }` | `{ id, authorizationUrl, expiresIn }` |
| `POST /native/auth/complete` | `{ id, verifier }` | `202 { pending }` or `{ token, deviceId }` |
| `GET /native/me` | — | `{ user: { id, name, login, provider, avatarUrl, email, roles, appCount }, device: { id, label, createdAt, expiresAt }, apps: [{ id, name, purpose, disclosure, version, grant }] }` |
| `PUT /native/apps/:appId/location` | `{ enabled: true, version }` | `{ grant }` |
| `DELETE /native/apps/:appId/location` | — | `{ revoked: true }` |
| `POST /native/locations` | `{ points: [{ id, at, lat, lng, accuracy, grants }] }` (1–100) | `{ acknowledged: [id] }` |
| `DELETE /native/device` | — | `{ disconnected: true }` |
| `POST /native/auth/code` (no credential) | `{ code, label }` | `{ token, deviceId }`; `403` expired or used, `429` too many tries ([QR pairing](#qr-pairing-845)) |
| `POST /native/pair-codes` | — | `{ code, url, expiresAt }` (a code for another phone, [below](#qr-pairing-845)) |

Every device call (pairing included) should carry `X-FAS-App-Version: <version label>` and `X-FAS-Client:
android | ios | desktop` ([below](#versions-and-the-device-list-833)).

Console side, with a first-party (`console`) session:

| Call | Response |
|---|---|
| `GET /native/devices` | `{ devices: [{ id, label, client, version, createdAt, lastSeenAt, expiresAt, pairedBy }] }`, most recently seen first |
| `DELETE /native/devices/:id` | `{ revoked: true }`; `404` if it is not one of yours |
| `POST /native/pair-codes` | `{ code, url, expiresAt }` |

App side, with the app's own session (`aud` = app id):

| Call | Response |
|---|---|
| `GET /apps/:appId/native/status` | `{ available, enabled, lastPointAt }` |
| `GET /apps/:appId/native/locations?after=<ms>&afterId=<cursorId>` | `{ points: [{ id, grantId, at, lat, lng, accuracy, cursorId }] }`, 500 per page |

The pairing pages (`/native/auth/authorize`, `/callback`, `/approve`) are
browser pages on the API origin, opened by the phone.

## Data lifecycle

- Points are kept 7 days, then pruned by the `*/15` cron.
- Turning an app off deletes its grant and every point under it.
- Disconnecting the phone deletes the device, its grants and points.
- Deleting your account (`DELETE /v1/auth/me`) deletes your devices, any pairing in progress and your pairing codes.
- Pairing codes are kept 30 days after they expire, then pruned by the cron.
- An app changing owner or being deleted revokes its grants.
- Device credentials expire after 90 days.

## Versions and the device list (#833)

Each app sends its version label, the one its Contribute attempt records carry (`0.4.0 (57, abc1234)`, or `(dev, …)`
for a local build), in `X-FAS-App-Version`, and its kind in `X-FAS-Client` (`android`, `ios` or `desktop`), on
`POST /native/auth/complete`, `POST /native/auth/code` and every call with the device credential. The label is at most
64 characters of letters, digits, space and `.,()+-_`; anything else, or another kind, is ignored. The backend keeps the
last value of each on the device row (`native_devices.app_version`, `client`) with `last_seen_at`, and writes them only
when one changed or `last_seen_at` is over 15 minutes old, so a busy device costs no write per request. A call without
the headers still updates `last_seen_at` and keeps the last version.

The console's **Settings > Devices** (`/app/build/profile`) lists the signed-in account's devices from
`GET /native/devices` (label, kind, version, paired, last seen, expires, and whether it was paired by a code and from
where) with **Revoke** (`DELETE /native/devices/:id`; the device's grants and points go with it, and its next call gets
`401`).

## QR pairing (#845)

A phone can pair without the browser flow by scanning a code shown where the account is already signed in: the
console's **Settings > Devices > Add a phone**, or the desktop app's **Account > Add a phone** (made with its device
credential).

- `POST /native/pair-codes` makes a code: 16 Crockford base32 characters (80 random bits), shown as
  `ABCD-EFGH-JKMN-PQRS`, valid 5 minutes, usable once. Only its SHA-256 is stored, with who made it (`console` or
  `ndev:<device id>`), when, and later the device it paired; the row stays 30 days after it expires as the record. Each
  account may make 20 a day (`429` beyond).
- The QR code holds `url`: `freeappstore://native/pair?code=ABCDEFGHJKMNPQRS` (the code without dashes). The code is
  also shown as text, to type on a phone without a camera.

**Phone side** (the contract for the Android and iOS apps):

1. Offer **Scan a code** next to **Connect** while not connected. Scan with the camera in the app (CameraX/ML Kit
   barcode or `AVCaptureMetadataOutput` `.qr`; no remote service), and also handle the deep link
   `freeappstore://native/pair?code=…` (a QR scanned by the system camera opens it). Offer **Type the code** as well.
2. Accept only `freeappstore://native/pair` with a `code` parameter; anything else is not a FreeAppStore code. Take the
   code as typed or scanned: the server ignores case, spaces and dashes and reads `I`/`L` as `1` and `O` as `0`.
3. Ask before pairing ("Connect this phone to the account that showed this code?"); a link never pairs by itself.
4. `POST https://api.freeappstore.online/v1/native/auth/code` with `Content-Type: application/json`,
   `X-FAS-App-Version` and `X-FAS-Client`, and `{ "code": "<code>", "label": "<the same label as the browser flow>" }`
   (label 1-80 characters, body at most 4 KB).
5. `200 { token, deviceId }`: store the `ndev_` token exactly as after the browser flow (same storage, same 90-day
   expiry) and go on as connected (`GET /native/me`). `403`: expired or already used, ask for a new code. `400`: not a
   code, or no label. `429`: too many tries from this network today (30 per IP), try again tomorrow. `401`: the
   account was deleted meanwhile.
6. Never log or keep the code; it is useless once used, but it is a credential until then.

The console polls its device list while the code is shown and closes the dialog when the new device appears.

## Signed-in profile (#829)

The phones and the desktop app show who they are signed in as, from `GET /native/me` with the device credential:
avatar, name, `@login` (GitHub) or the sign-in provider, user id, email if any, platform roles (`user`, `creator`,
`admin`, derived as for `/auth/me`), the creator's app count with a link to the console, and this device's label,
pairing date and expiry. The endpoint reads only the credential owner's own row and stores nothing new. The phones
keep the last answer on the device (Settings; avatar and name in the Store header or toolbar), the desktop app in
memory (Account page; header and tray menu). **Sign out** revokes this device's credential (`DELETE /native/device`);
**Delete account** opens the console's deletion flow (#653).

## On the phone (iOS)

- **Pause all** stops new samples. **Pausing one app** stops tagging new samples for that app only; its grant,
  consent and platform copy are unchanged, and it resumes without a new disclosure. Previously authorized queued
  samples can still upload in both cases. Pause is local to the phone and is not reported to the app.
- The companion keeps a 30-day on-device history (`share_events`, `share_points`) in its protected queue
  database, for your own sharing map, session timeline and **Activity** log (sharing changes, upload and
  permission problems). It is never uploaded, is excluded from backups, and is deleted by **Clear sharing
  history** or **Disconnect this phone**.
- The sharing map draws that history from the phone. Map backgrounds come from Apple Maps, so Apple receives the
  map area you view; your shared track is not sent to Apple or to FreeAppStore when you view it.
- The **Store** tab lists every public FAS app from `https://freeappstore.online/registry.json`, fetched
  without credentials (conditional GET, cached on the phone so it works offline, kept across disconnect).
  **Open** goes to the app in the browser; the first time for each app it shows how to add it to the Home
  Screen (Share → Add to Home Screen), with **Don't show this again**. Apps on the recipient list get **Use with
  companion**, which opens the same disclosure as the Sharing tab. Browsing never creates a grant.

## On the phone (Android)

- `android/` is the Android port (package `online.freeappstore.companion`) with the same pairing, per-app consent,
  Pause all, per-app pause and upload queue, in three tabs: Store, Sharing and Settings (#649).
- Like iOS, it keeps a 30-day on-device history (`share_events`, `share_points`) in the backup-excluded queue
  database for the Sharing control room (per-app state, shared time today, upload queue, sync health, device
  status), the per-app session timeline and the activity log. It is never uploaded, and it is cleared by **Clear
  sharing history** (the upload queue stays) and by **Disconnect this phone**. Reconnecting the same account after an
  expiry keeps it. Tracks are drawn on a plain Compose canvas: no map SDK, no tiles, no map provider sees them.
- Its **Store** tab lists `https://freeappstore.online/registry.json` (cached, revalidated, fetched without
  credentials). **Open** goes to the app at `?install=1`. The host then adds `/.fas/install.js`, which shows an
  **Install** button when Chrome offers to install the app. Without the parameter, apps are served unchanged.

## Contribute (Android, #731)

Part of community generation ([#727](https://github.com/freeappstore-online/platform/issues/727)). A paired phone can
generate an app's published jobs (narration today) and upload them for everyone. The server decides what is generated
and verifies every upload; the phone is never trusted.

- **Opt in per app**: the **Contribute from this phone** switch on an app's Store page, Contribute's Settings, or the deep
  link `freeappstore://native/contribute/<appId>`. Each asks first; a link never opts in by itself.
- **Model**: Kokoro v1.0 (multi-language, the weights Books' CI uses) through [sherpa-onnx](https://github.com/k2-fsa/sherpa-onnx)
  (Apache-2.0). The runtime is the pinned sherpa-onnx `2.0.3` AAR (fetched by Gradle into `android/app/libs` and checked
  against its SHA-256). The model (`kokoro-multi-lang-v1_0.tar.bz2`, 350 MB download, 401 MB unpacked) is downloaded only
  when asked, from the pinned sherpa-onnx `tts-models` release URL, refused unless its SHA-256 matches, unpacked into
  no-backup storage, and can be deleted. Claims declare `{ model: "kokoro", modelVersion: "v1.0" }`.
- **Job params** the phone honours: `{ voice, speed? }`, `voice` a Kokoro voice name (`af_heart`, …), `speed` 0.5-2
  (default 1). A job with any other param, another model or version, a format list without `audio/mp4`, or an input other
  than `{ text }` is skipped, never approximated.
- **Loop** (WorkManager, hourly and on **Run now**; by default only while plugged in on an unmetered network, which the
  user can relax; foreground notification with Stop, and in-app download progress for the model). "Plugged in" is
  `BatteryManager.EXTRA_PLUGGED != 0`, not "charging", which Android reports unsatisfied once the battery is full (#806).
  The work is scheduled with battery-not-low and a *connected* network only: the worker checks plugged-in before starting
  and between sentences, and unmetered before starting and before each claim, because a WorkManager constraint that lapses
  stops running work part-way. The connected constraint is needed (#828): Android 17 blocks the network of an app in the
  background (`blocked=APP_BACKGROUND`) except for a job that asked for one. Unplugged, it stops without uploading. A run
  in progress is never replaced by **Run now** or a settings change; otherwise the hourly work takes the current
  constraints. If Android refuses the foreground service, the run is a plain job: it claims only in its first 5 minutes
  and ends itself at 9, before the system times it out, recording the job in hand `stopped` (`background_expired`).
  A `429` at the claim (the app's daily budget, or 4 open leases) ends the run. Each run logs `ContributeWorker: Run ended: <reason>`. On power
  (#836) it does not wait for the hourly work: a one-time work with a charging constraint (and a connected network) starts
  a run as soon as the phone is plugged in. It only queues the run (unique `contribute-next`, kept if one is queued or
  running), so the charging constraint never stops a run part-way. A run that ends at its time limit (`time_budget`)
  while still plugged in and able to claim queues the next one at once, after itself and never instead of it
  (`APPEND_OR_REPLACE`; JobScheduler's quotas do not apply while charging). A run that ends for any other reason (no jobs,
  not on Wi‑Fi, the daily limit, a Stop) re-arms the trigger: an hour later while still plugged in, so nothing spins, or
  for the next plug-in. The run-ended log line says which (`next: NEXT | TRIGGER | TRIGGER_LATER`). The hourly work stays
  as the fallback. A job stopped
  part-way is recorded and never retried on this phone, which Activity says.
  The run takes one job from each opted-in app in turn (#819), skipping apps with no open job, rather than finishing one
  app's jobs before the next; an app turned off mid-run is left out from its next turn.
  Each job: `POST …/generation/claim` with the device credential → synthesize the
  job's `input.text` verbatim, a sentence at a time, each sentence and pause fed to the encoder as it is synthesized
  (#793; the chapter is never held in memory, only a temp file in the cache) → AAC-LC mono 32 kbps at Kokoro's 24 kHz in
  MP4 (#798; `MediaCodec` + `MediaMuxer`) →
  `PUT …/jobs/:jobId/result` multipart (`file`, `audio/mp4`, and `meta`) with `X-Lease-Token`. Nothing is uploaded after
  the lease is within 30 s of expiry, above `maxBytes`, or with `meta` over 64 KB. A job is recorded before its upload
  starts and is never generated or uploaded again on this phone.
- **When it runs** (#830), all on the phone (the server sets no per-user limits): **Auto** (default) runs by itself
  whenever every condition holds and the status card says which one holds it ("Paused: Phone in use.", "Battery 28%
  (min 40%).", "On mobile data. It runs on Wi‑Fi only.", "Waiting: no jobs right now"); **Run now** is one run that
  ignores the conditions, then Auto; **Off** stops the job in hand and cancels the hourly work, the plug-in trigger and
  chained runs, and stays off across restarts and updates ("Contribute is off. It will not start again until you turn it
  on."). Conditions, defaults in brackets: connection Wi‑Fi only / Wi‑Fi + mobile data within a monthly allowance [Wi‑Fi
  only, 500 MB]; power charging only / also on battery above a floor [charging only, 40%]; pause when hot (thermal
  status moderate or worse) [on]; while the phone is in use (screen on and unlocked) pause / run slower [pause]; CPU
  Light (1 thread, rests as long as each sentence) / Balanced (2 threads, short rests) / Full (up to 4, none)
  [Balanced]; a daily maximum of jobs or minutes [none]; quiet hours [off]. They are checked before each claim and
  between sentences: a job at least 80% done is finished, any other stops and its attempt record carries an interrupted
  reason (`unplugged`, `thermal`, `network`, `user_stop`), so the server gives it back (#841). Mobile data (the model
  download and uploads on a metered network) is counted on the phone and resets each month. A run held by use or heat
  while plugged in looks again in 10 minutes. Phones that had "any time" on start with mobile data and battery allowed.
- **Retrying** (#841): a job this phone was interrupted on (`skipped` `stopped` / `lease_expired` / `interrupted`, or
  `failed` `network`) is generated again when the server offers it again; anything else stays done.
- **Overnight summary** (#844): after background work, one quiet notification such as "Generated 42 clips, 38 accepted,
  1 h 10 min CPU", once a morning (6 to noon) or after an hour of CPU; tapping it opens Activity. It is on by default,
  can be turned off in Contribute settings, and needs the notification permission the app asks for once.
- **Share record** (#843): a job's detail shares `fas-record-<job>.zip` (`record.json` with every field, the attempt
  record and the sentence timings, plus `audio.m4a` while the audio is kept) through the share sheet (FileProvider).
- **Network retries** (#819): a claim, the verdict refresh or an upload that fails with a transient error (no
  connection, DNS, timeout, connection reset, any `5xx`, or a `429` with `Retry-After`) is tried again after 2, 4, 8, 16,
  32, then 60 s (or the `Retry-After`). Claims and the refresh try for up to a minute. An upload sends the same encoded
  file again, extending the lease as it runs low, until it goes through or the lease is within 30 s of expiry; then the
  file is deleted and the job recorded `failed` with reason `network`. A `429` without `Retry-After` (the daily limit) and
  any other `4xx` are final.
- **Sentence timings** (#785): the text is split into sentences exactly as Books' `scripts/audio/segments.py` does (its
  English rules, or its Spanish ones for an `e…` voice), each sentence is synthesized alone, and they are joined with
  Books' pauses (0.4 s, 0.8 s after a paragraph). A sentence with no audio (`* * *`) is left out. `meta` is
  `{ "segments": [[charStart, charEnd, startSec, endSec], …] }`, offsets in UTF-16 code units into `input.text`, like
  Books' `timings.json`.
- **Lease extension** (#783): between sentences, once the lease is within 5 minutes of expiry, the phone calls
  `POST …/jobs/:jobId/lease` with `X-Lease-Token` and takes the returned `leaseExpiresAt`. A `403` stops the job without
  uploading; a `409` (the 2-hour cap) stops extending, so the job finishes only if the lease still allows. Other failures
  are retried after the next sentence.
- **Record**: `generation_jobs` in the backup-excluded database (job key, status, reason, and since #820 the first
  200 characters of the input, the uploaded audio's length and size, and from #824 the server's measured `durationMs`
  and the accepted `artifact` URLs; since #831, database version 7, the upload's `submissionId` and this phone's
  `report`), refreshed from `GET …/generation/submissions` for every app on the record. No AI checks the audio and the
  server sends no `wer`; a version 5 or 6 table keeps an unused `wer` column. Cleared by **Disconnect**.
- **Screens** (#820): the **Contribute** tab is one status card (running with app, job, sentence n of N and speed as
  seconds of audio per second of work; or paused or idle and why: no model, no apps, not plugged in, no connection, not on
  Wi‑Fi) with **Run now** / **Stop**, and today's counts (in progress, accepted, checking, rejected, not done) as chips that open
  **Activity** filtered. **Activity** lists every job this phone tried, newest first and by day, with status chips (All ·
  In progress · Accepted · Checking · Rejected · Not done; "Not needed" counts as Not done) and app chips, and pull to refresh the
  verdicts. **In progress** (#835): a job is on the record as `generating` from its claim, its attempt record replaced at
  each sentence by the record so far (model, sentence n of N, wall and CPU time so far, device, lease expiry; kept on the
  phone, never sent); its detail follows it live (the screen re-reads every 2 s) and plays its audio once encoded, before
  the upload. A run that starts finds no other run live, so it closes any `generating` row left by a killed run as
  `skipped` with reason `interrupted`. A row opens the job: app, key, input preview, time, length and size, the phone's reason or the server's
  verdict and reason, and for an accepted job **Play**, which streams `artifact.url` and highlights the
  sentence being spoken in the job's whole `input.text` (fetched from the submissions route when the detail opens; the
  stored preview when offline) from the `artifact.metaUrl` timings. For a job this phone uploaded, **Your report**
  (#831): **Good** / **Not good**, an optional note (at most 500 characters) and **Send** (**Change** once sent), which
  calls `PUT …/generation/submissions/:submissionId/report` with the device credential; the report is kept on the row,
  so it shows offline, and a refresh takes the server's `report`. The app's owner sees it in the console. **Settings** (gear icon): the apps opted in, plus apps with open jobs for this phone from
  `GET /generation/open` (sets in `kokoro` `v1.0` and `audio/mp4`), each with its switch and open-job count; the voice
  model with download progress and delete; **Only while plugged in on Wi‑Fi**; and the storage the model and the record use.
- **Attestation**: `X-Attestation` is sent when the `Attestation` hook returns a token; none until #732.

## Contribute (iOS, #733)

The iPhone companion does the same work as the Android one, with the same rules: per-app opt-in, the same Kokoro model and
claims, the same skipping, sentence timings, lease extension, upload checks and on-device record. Only what differs on iOS:

- **Where** (#820): the **Contribute** tab is one status card (running, paused while hot, idle or stopped and why, the
  app and job in hand, sentence n of N with speed as audio seconds per second, **Run now** / **Stop**) and today's counts
  as chips (In progress, Accepted, Checking, Rejected, Not done) that open **Activity** filtered. **Activity** lists every job this
  phone tried, newest first, grouped by day, filtered by status (All · In progress · Accepted · Checking · Rejected · Not done) and by
  app; pull to refresh reads the server's verdicts for every app on the record. **In progress** (#835): a job is on the
  record as `generating` from its claim, its attempt record updated at each sentence with the model, sentences done of
  all, wall and CPU time so far and the lease's expiry (kept on the phone only, never sent with the attempt event); its
  detail follows it live and plays its audio once encoded. A `generating` row with no live run (a crash or a kill) is
  closed as `skipped` with reason `interrupted` when the app starts and when a run starts or ends. A row opens the job: app, key, when, the
  audio's length and size, this phone's reason or the server's verdict and reason, the job's text, and **Play** for an accepted job (or, on a superseded one, the winning audio) from the public artifact URL, marking each sentence from the
  public meta's `segments` as it plays. For a job this phone uploaded, **Your report** (#831): **Good** / **Not good** with an
  optional note (at most 500 characters) and **Send**, which calls `PUT /v1/apps/:appId/generation/submissions/:submissionId/report`
  with the device credential. No AI judges the audio; a person listening does. The row keeps the upload's submission id and
  the last report (sent from here or read from the submissions route's `report` on refresh), so it shows offline and can
  be changed. The gear opens **Contribute settings**: the apps opted in or with open jobs
  (`GET /generation/open`, Kokoro sets only) with their switch and open-job count, the voice model download, progress
  and delete, **When to run** (the conditions, below), **Overnight summary**, and the space the model and the record
  take. A **Contribute from this phone** switch
  is also on each app's Store page while signed in, and the link `freeappstore://native/contribute/<appId>`. Each asks
  first; a link never opts in by itself.
- **Modes and conditions** (#830), all on the phone (the server has no per-user cap). The status card starts with
  **Auto · Run now · Off**. **Auto** (default) runs in the background whenever every condition holds and always says
  why it is not running ("Paused: on mobile data (Wi-Fi only).", "Paused: battery 28% (min 40%).", "Waiting: no
  connection."). **Run now** is one run that ignores the conditions (apart from pausing while hot), then Auto again; it
  also turns Off back to Auto. **Off** is a hard stop: it stops the job in hand, cancels the `BGProcessingTask` request
  (`BGTaskScheduler.cancel`) and any reschedule, a request iOS still delivers ends at once, and it is stored on the phone
  so it survives relaunches and updates ("Contribute is off. It will not start again until you turn it on."). The
  conditions, defaults in brackets: connection **Wi-Fi only** / **Wi-Fi + mobile data** with a monthly MB allowance
  [Wi-Fi only, 500 MB] (`NWPathMonitor`; mobile data used by the model download and uploads is counted on the phone and
  starts again each month); power **Charging only** / **Also on battery** at or above a minimum [charging only, 40%]
  (the request's `requiresExternalPower` follows it); **Pause when hot** at `ProcessInfo.thermalState` serious or above
  [on] (the job waits, lease kept, and goes on once cool); **Low Power Mode** always pauses; **CPU** Light (1 thread, 1 s
  rest between sentences) / Balanced (2 threads, 0.25 s) / Full (up to 4 threads, no rest) [Balanced]; **While the
  phone is in use** Pause / Run slower [Pause] (iOS only runs background work while the phone is not in use, so on
  iPhone this only changes Run now, which uses Light while on screen with Run slower); optional daily maximums of jobs
  and of minutes worked; optional quiet hours. A background run checks them before each claim and between sentences.
  When one fails, the job in hand is finished and uploaded if at least 80% of its sentences are done; otherwise it stops,
  is recorded `skipped` with the condition (`off`, `quiet_hours`, `daily_max`, `no_network`, `mobile_data`, `data_cap`,
  `unplugged`, `battery_low`, `low_power`) and its attempt record is sent with an interrupted end reason (`user_stop`,
  `network` or `unplugged`), so the server gives the job back (#841). There is no lease release route: the lease lapses
  or is released by this runner's next claim. The run then claims nothing more, and asks iOS for the next one 15 minutes
  out. "Only while charging" from before (#820) carries over as the power condition.
- **Jobs given back** (#841): a job this phone stopped part-way (`skipped` or `failed` for an interruption, such as
  `user_stop`, `background_expired`, `interrupted`, `network`, `lease_expired` or a condition above, with no upload) is
  taken again when the server offers it. One it refused, failed on otherwise or uploaded is never generated again.
- **Overnight summary** (#844): after background work, one quiet (`passive`) local notification is due the next morning
  at 8:00, such as "Generated 42 clips, 38 accepted, 1 h 10 min CPU" for the work since the last one shown; each
  background run brings it up to date, and a night with nothing generated shows none. Tapping it opens Activity. On by
  default in Contribute settings; notification permission is asked only when it is turned on or when an app is opted
  in, and the settings say so if notifications are off for FreeAppStore.
- **Share record** (#843): a job's detail has **Share record**, which shares `<jobId>.json` (every field of the row and
  its attempt record, device-only progress fields included, and the report) and the audio while this phone keeps it,
  through the share sheet.
- **Runtime**: the official sherpa-onnx `2.0.3` iOS xcframework with onnxruntime linked in
  (`sherpa-onnx-v2.0.3-ios-shared-onnxruntime-static.xcframework.zip`), called through its C API. The scheme's build
  pre-action (`ios/scripts/fetch-sherpa-onnx.sh`) fetches it into the untracked `ios/Vendor/` and refuses it unless its
  SHA-256 matches the pinned one.
- **Model**: the same pinned `kokoro-multi-lang-v1_0.tar.bz2` and SHA-256, downloaded only on **Download** or after an
  opt-in, verified before anything is unpacked (libbz2 and a tar reader that takes only regular files and folders inside
  the model folder), kept in Application Support excluded from backup, and deletable from the tab.
- **When**: a `BGProcessingTask` (`online.freeappstore.companion.contribute`) that iOS starts only on external power with a
  network connection, at most every 15 minutes and at the system's discretion; a background run never downloads the model
  over a cellular or Low Data network. **Run now** runs in the foreground while the app is open and keeps the screen awake
  meanwhile (auto-lock would otherwise background the app). When iOS ends either (the task's expiration handler, or the
  app's background time running out after leaving it), the job in hand stops between sentences and is not uploaded.
  Leaving the app during **Run now**, or Run now ending with `background_expired`, submits the background task request
  with no earliest start (#819), so the work goes on as soon as iOS allows on external power; the tab says plainly that
  Run now needs the app on screen and background runs happen while charging. **Keep going while charging** (#836): a
  background run that ends with jobs left (iOS expired it, or a job was not done, such as one whose lease ran out)
  submits the next request with no earliest start; one that found nothing to claim, failed (the daily limit among
  them) or was stopped asks for 15 minutes out, so the phone does not spin. Plugging in while the app is running
  (`UIDevice.batteryStateDidChangeNotification`), and leaving the app while plugged in, also ask with no earliest
  start. What iOS still controls: whether and when a requested run starts (most often with the phone locked, on power
  and a connection, and less for an app the user rarely opens), how long it lasts before expiring, and that nothing is
  delivered while the app is suspended or killed. Plugging in does not start **Run now** by itself: Run now keeps the
  screen awake, which stays the user's choice. Once the app has left the screen, Run now
  claims nothing more (#828): the job in hand may finish in the seconds left, then the background task carries on.
  The daily limit's `429` at the claim ends a run; each run logs `Run ended: <reason>` (subsystem
  `online.freeappstore.companion`, category `Contribute`). Unplugging, with Charging only, stops a background run (unless the job is nearly done). A stopped job is recorded `skipped` with why: `user_stop`, `background_expired`,
  `opted_out`, `lease_expired` or a condition above, shown in the tab's recent results.
- **Order** (#819): one job per opted-in app in turn (Books, then Dialogue, then Books, …), so every app moves forward;
  an app leaves the rotation for the run when it has no open job, is turned off, or a job of it is not submitted.
- **Network** (#819): claims, uploads and verdict refreshes are tried again after passing failures (no connection, DNS,
  timeouts, a dropped connection, 5xx, 408, and 429 only with `Retry-After`), waiting 2 s doubling to 60 s, or what
  `Retry-After` says; a failed lease extension is tried again at the next sentence or upload try. A claim or refresh
  gets six tries; an upload keeps the encoded file and sends the
  same file again for as long as the lease leaves time, then gives up as `failed` with reason `network`. Nothing is ever
  generated twice. If a retry finds the lease already used (the earlier answer was lost), the server's record is read.
- **Languages** (#812), as on Android: a set's `language` (#810) must match its voice: `en` with an `a…`/`b…` voice, `es`
  with `e…`, `zh` (`zh-Hans`, `zh-CN`, …) with `zf_`/`zm_`; a set naming no language goes by the voice. Anything else is
  skipped with reason `language`. Mandarin is spoken through `lexicon-zh` with the package's `date-zh`, `phone-zh` and
  `number-zh` rules (a separate engine, so digits in English text stay English), and split into sentences at 。！？；…
  and `!?;` or a `.` not before a digit, whatever follows, closing quotes and brackets kept. Audio shorter than 1 s is
  padded with silence, so a two-character phrase such as 对。 stays within the server's characters-per-second band.
- **Heat**: while the thermal state is *serious* or *critical* the run pauses between sentences (and before claiming),
  keeps extending the job's lease, and goes on once the phone is back to *fair* or *nominal*.
- **Encoding**: each sentence and pause is written as it is synthesized into an `ExtAudioFile` (Apple's software AAC-LC
  encoder, mono 32 kbps at Kokoro's 24 kHz, `.m4a`; #798, so long chapters fit 25 MB) in the temporary folder; the
  chapter is never held in memory.
- **Record**: `generation_jobs` in the protected, backup-excluded queue database, refreshed from `GET …/generation/submissions`
  when the app opens and on pull to refresh in Activity. Since #820 (migration 1, `PRAGMA user_version`) it also keeps the
  job's text and set, the audio's length and size, and (migration 3, #831) the submission id and this phone's Good / Not good report; a refresh also takes the measured duration and, for a row without it, the text (#824). The opt-ins and the record are
  cleared by **Disconnect**.
- **Attestation**: the `Attestation` hook is where an App Attest assertion for `X-Attestation` goes (#732); it returns
  nothing yet, so nothing is sent.

