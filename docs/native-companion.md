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
| `GET /native/me` | — | `{ user, device, apps: [{ id, name, purpose, disclosure, version, grant }] }` |
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

- **Opt in per app**: the **Contribute from this phone** switch on an app's Store page, the Contribute tab, or the deep
  link `freeappstore://native/contribute/<appId>`. Each asks first; a link never opts in by itself.
- **Model**: Kokoro v1.0 (multi-language, the weights Books' CI uses) through [sherpa-onnx](https://github.com/k2-fsa/sherpa-onnx)
  (Apache-2.0). The runtime is the pinned sherpa-onnx `2.0.3` AAR (fetched by Gradle into `android/app/libs` and checked
  against its SHA-256). The model (`kokoro-multi-lang-v1_0.tar.bz2`, 350 MB download, 401 MB unpacked) is downloaded only
  when asked, from the pinned sherpa-onnx `tts-models` release URL, refused unless its SHA-256 matches, unpacked into
  no-backup storage, and can be deleted. Claims declare `{ model: "kokoro", modelVersion: "v1.0" }`.
- **Job params** the phone honours: `{ voice, speed? }`, `voice` a Kokoro voice name (`af_heart`, …), `speed` 0.5-2
  (default 1). A job with any other param, another model or version, a format list without `audio/mp4`, or an input other
  than `{ text }` is skipped, never approximated.
- **Loop** (WorkManager, hourly and on **Run now**; by default only while charging on an unmetered network, which the user
  can relax; foreground notification with Stop): `POST …/generation/claim` with the device credential → synthesize the
  job's `input.text` verbatim, a sentence at a time, each sentence and pause fed to the encoder as it is synthesized
  (#793; the chapter is never held in memory, only a temp file in the cache) → AAC-LC mono 64 kbps in MP4
  (`MediaCodec` + `MediaMuxer`) →
  `PUT …/jobs/:jobId/result` multipart (`file`, `audio/mp4`, and `meta`) with `X-Lease-Token`. Nothing is uploaded after
  the lease is within 30 s of expiry, above `maxBytes`, or with `meta` over 64 KB. A job is recorded before its upload
  starts and is never generated or uploaded again on this phone.
- **Sentence timings** (#785): the text is split into sentences exactly as Books' `scripts/audio/segments.py` does (its
  English rules, or its Spanish ones for an `e…` voice), each sentence is synthesized alone, and they are joined with
  Books' pauses (0.4 s, 0.8 s after a paragraph). A sentence with no audio (`* * *`) is left out. `meta` is
  `{ "segments": [[charStart, charEnd, startSec, endSec], …] }`, offsets in UTF-16 code units into `input.text`, like
  Books' `timings.json`.
- **Lease extension** (#783): between sentences, once the lease is within 5 minutes of expiry, the phone calls
  `POST …/jobs/:jobId/lease` with `X-Lease-Token` and takes the returned `leaseExpiresAt`. A `403` stops the job without
  uploading; a `409` (the 2-hour cap) stops extending, so the job finishes only if the lease still allows. Other failures
  are retried after the next sentence.
- **Record**: `generation_jobs` in the backup-excluded database (job key, status, reason), refreshed from
  `GET …/generation/submissions`; the tab shows today's count per app and recent results. Cleared by **Disconnect**.
- **Attestation**: `X-Attestation` is sent when the `Attestation` hook returns a token; none until #732.

