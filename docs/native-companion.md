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
- Deleting your account (`DELETE /v1/auth/me`) deletes your devices and any pairing in progress.
- An app changing owner or being deleted revokes its grants.
- Device credentials expire after 90 days.

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
  constraints. If Android refuses the foreground service, the run is a plain job and claims only in its first 5 minutes.
  The daily limit's `429` at the claim ends the run. Each run logs `ContributeWorker: Run ended: <reason>`. A job stopped
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
  200 characters of the input, the uploaded audio's length and size, and from #824 the server's `wer`, measured
  `durationMs` and the accepted `artifact` URLs), refreshed from `GET …/generation/submissions` for every app on the
  record. Cleared by **Disconnect**.
- **Screens** (#820): the **Contribute** tab is one status card (running with app, job, sentence n of N and speed as
  seconds of audio per second of work; or paused or idle and why: no model, no apps, not plugged in, no connection, not on
  Wi‑Fi) with **Run now** / **Stop**, and today's counts (accepted, checking, rejected, not done) as chips that open
  **Activity** filtered. **Activity** lists every job this phone tried, newest first and by day, with status chips (All ·
  Accepted · Checking · Rejected · Not done; "Not needed" counts as Not done) and app chips, and pull to refresh the
  verdicts. A row opens the job: app, key, input preview, time, length and size, the phone's reason or the server's
  verdict, reason and error rate, and for an accepted job **Play**, which streams `artifact.url` and highlights the
  sentence being spoken in the job's whole `input.text` (fetched from the submissions route when the detail opens; the
  stored preview when offline) from the `artifact.metaUrl` timings. **Settings** (gear icon): the apps opted in, plus apps with open jobs for this phone from
  `GET /generation/open` (sets in `kokoro` `v1.0` and `audio/mp4`), each with its switch and open-job count; the voice
  model with download progress and delete; **Only while plugged in on Wi‑Fi**; and the storage the model and the record use.
- **Attestation**: `X-Attestation` is sent when the `Attestation` hook returns a token; none until #732.

## Contribute (iOS, #733)

The iPhone companion does the same work as the Android one, with the same rules: per-app opt-in, the same Kokoro model and
claims, the same skipping, sentence timings, lease extension, upload checks and on-device record. Only what differs on iOS:

- **Where** (#820): the **Contribute** tab is one status card (running, paused while hot, idle or stopped and why, the
  app and job in hand, sentence n of N with speed as audio seconds per second, **Run now** / **Stop**) and today's counts
  as chips (Accepted, Checking, Rejected, Not done) that open **Activity** filtered. **Activity** lists every job this
  phone tried, newest first, grouped by day, filtered by status (All · Accepted · Checking · Rejected · Not done) and by
  app; pull to refresh reads the server's verdicts for every app on the record. A row opens the job: app, key, when, the
  audio's length and size, this phone's reason or the server's verdict and reason (and error rate when the server sends
  `wer`), the job's text, and **Play** for an accepted job (or, on a superseded one, the winning audio) from the public artifact URL, marking each sentence from the
  public meta's `segments` as it plays. The gear opens **Contribute settings**: the apps opted in or with open jobs
  (`GET /generation/open`, Kokoro sets only) with their switch and open-job count, the voice model download, progress
  and delete, **Only while charging** (on by default; off, the background task no longer asks for external power and
  unplugging no longer stops it), and the space the model and the record take. A **Contribute from this phone** switch
  is also on each app's Store page while signed in, and the link `freeappstore://native/contribute/<appId>`. Each asks
  first; a link never opts in by itself.
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
  Run now needs the app on screen and background runs happen while charging. Once the app has left the screen, Run now
  claims nothing more (#828): the job in hand may finish in the seconds left, then the background task carries on.
  The daily limit's `429` at the claim ends a run; each run logs `Run ended: <reason>` (subsystem
  `online.freeappstore.companion`, category `Contribute`). Unplugging stops a background run. A stopped job is recorded `skipped` with why: `user_stop`, `background_expired`,
  `unplugged`, `opted_out` or `lease_expired`, shown in the tab's recent results.
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
  job's text and set, the audio's length and size, and the server's error rate; a refresh also takes the measured duration and, for a row without it, the text (#824). The opt-ins and the record are
  cleared by **Disconnect**.
- **Attestation**: the `Attestation` hook is where an App Attest assertion for `X-Attestation` goes (#732); it returns
  nothing yet, so nothing is sent.

