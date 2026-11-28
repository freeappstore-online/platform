# Community generation

Apps can let signed-in users' devices generate pregenerated assets (today: TTS narration) with a
local model and contribute them for everyone. The device is never trusted; the server decides what
is generated, verifies every upload before it is public, and never overwrites a published asset.
Epic: [#727](https://github.com/freeappstore-online/platform/issues/727). Implementation:
`packages/backend/src/routes/generation.ts`.

## Threat model

- **Users can't choose what is generated.** The app owner publishes *sets* (model, model version,
  params) and *jobs* (key + input). Devices only claim open jobs and upload against the lease.
- **Nothing is overwritten.** A job id is the SHA-256 of set + key + input + model/version/params.
  The first submission that passes verification becomes the artifact. `generation_artifacts.job_id`
  is the primary key, so a second accept cannot insert and is `superseded`. Artifact objects are
  stored under a key unique to their submission. Only the owner can withdraw (audited), which
  reopens the job.
- **Every upload is quarantined** in private storage until the verifier accepts it.
- **Provenance and limits.** Each artifact records contributor, device kind (`web` / `native`),
  attestation status and model/version. Owners can block a contributor, which withdraws everything
  they contributed to the app.

Attestation (`X-Attestation`) is recorded as `unverified` until #732 lands. Sets created with
`requireAttestation: true` are not claimable until then.

Owners see their sets in the Creator Console: an app's **Generation** tab
(`freeappstore.online/app/`) shows each set's progress, its jobs (filter by status, page with
*Load more*), plays accepted audio with sentence highlighting from the meta `segments`, lists the
latest submissions (status, reason, duration, contributor, device and attestation, and the
contributor's own Good / Not good report with its note) and can withdraw an artifact or block a
contributor. Highlighting follows the whole text, which the tab reads with
`GET …/sets/:setId/jobs/:jobId` when the audio starts.

People judge quality, never AI ([#831](https://github.com/freeappstore-online/platform/issues/831)).
Each runner's history (Android, iOS, desktop, the console's Generate page) has **Good / Not good** and
an optional note for every upload the device made; it is sent to `…/submissions/:id/report` and the
owner sees it on that submission. In the Generation tab the owner listens to the accepted audio and
marks that exact version **Reviewed** or **Needs changes** with a note (`…/artifacts/:jobId/review`,
audited), or withdraws it. The jobs list filters by review, and **History** lists every review of every version of
the job. An artifact is shown as *Not reviewed* until then, and a version generated
again (after a withdrawal) is a new, unreviewed one: a review is never carried over. A review or report
never publishes, withdraws or changes the manifest.

The Generation tab's **Review queue** (#842) plays the unreviewed artifacts one after another (`…/review`),
device-reported *Not good* first, with keys G (reviewed), B (needs changes) and N (next). Each contributor's
**good rate** counts their judged submissions: the owner's review where there is one, else the device's own
report. The owner can set an **auto-block** threshold (`…/settings`): once a contributor has at least 5 judged
submissions and a good rate below it, they are blocked as by **Block** (audited as `contributor.autoblock`). It
is checked when set and whenever one of their submissions is reviewed or reported.

Any signed-in creator can generate for every store app from the console's **Generate** page
(`freeappstore.online/app/generate`, desktop browsers with WebCodecs AAC): it lists the apps with open
work from discovery, runs Kokoro sets (`kokoro` `v1.0`, `audio/mp4`) for the apps they opt in to, after
they agree to download the model. It uses the SDK's shared browser runner,
`@freeappstore/sdk/generation-kokoro` (also used by Books), takes one job from each opted-in app in turn
like the phones, and keeps going in a background tab or a minimised installed console while the browser
runs ([Running in the background](#running-in-the-background)).
The page has three tabs (#820): **Status** (running, idle or paused and why; the current app, job,
sentence n/N and speed; Start/Stop; today's accepted, checking, rejected and not-done counts, which
open Activity filtered), **Activity** (the account's `mySubmissions()` for every app it may have worked
for, plus this browser's own run records in localStorage for jobs it skipped, stopped or failed;
filter by status and app, grouped by day; a row opens its detail with the verdict and reason, size,
duration, and Play with sentence highlighting for accepted ones, from the set's public manifest) and
**Settings** (apps with open work and the per-app opt-in, the model download/delete, storage used).
The job in hand is **In progress** from its claim (#838): on Status and in Activity it opens a detail that
updates live (app, key, input, model and voice, sentence n/N, elapsed, device, lease expiry, and the audio
once encoded; a browser has no process CPU time). Stopped or failed, it leaves In progress with the reason; a
page closed mid-job shows it interrupted when the console opens again. Every Activity detail has
**Download record** (#843): `record.json` (the submission, this browser's run and attempt record, the live
job) and the audio, this browser's own or else the accepted artifact, for bug reports.

Every runner keeps a record of each attempt on the device (#827) and sends its numbers to
`…/generation/events` (below): runner, app version, OS and device, network, foreground or background,
how it ended, wall time per stage (model load, synthesis, encode, upload), process CPU time, speed,
peak memory, battery and thermal state at start and end, where the platform exposes them. Each
runner's history shows it with the server's verdict and plays the device's own audio with sentence
highlighting, for the 20 latest attempts it kept (rejected ones too): the console's Activity detail
(audio in Cache Storage; no CPU time, memory or thermal state in a browser), the Android and iOS
Activity job detail. The owner sees each upload's record, and attempts that never uploaded, in the
Generation tab's jobs.

Each runner takes a **capability report** when a run starts and logs it (#813): the runner and its version, OS
and device, whether the model is installed, the accelerator (the phones and desktop run sherpa-onnx on the CPU;
the browser names WebGPU or WebAssembly, asked for and actually used, since WebGPU falls back), the AAC encoder,
free storage, and battery, power and thermal state. **Copy diagnostics** (Android and iOS Contribute settings, the
console Generate page's Settings, the desktop's Contribute) copies that report, how the last run ended and the 50
latest jobs with their status, reasons and attempt records, for a bug report. It stays on the device until pasted,
and holds no input text, audio, report notes or credentials. Attempts that end before any claim (no model, no
apps, a condition holding) have no job, so the server never sees them; the run's end is in the diagnostics. The
browser and desktop runners name an end with the SDK's `kokoroEndReason`: a model that fails to load or speak,
or a model worker that crashes, is `model_error`, and an encoder failure is `encode_error`.

## API (base `https://api.freeappstore.online/v1`)

Owner: the app owner's session (the app's own or a console session), or a GitHub Actions OIDC token
(audience `https://api.freeappstore.online`) from `refs/heads/main` of the repository the app is
pinned to. A repository is pinned by the app's first keyless deploy.

| Call | Body | Result |
|---|---|---|
| `POST /apps/:appId/generation/sets` | `{ kind: 'tts', model, modelVersion, params, formats, maxBytes, replicas, requireAttestation?, language?, minCharsPerSecond?, maxCharsPerSecond? }` | `201 { set }` |
| `POST /apps/:appId/generation/sets/:setId/jobs` | `{ jobs: [{ key, input: { text } }] }`, 1-500 | `{ jobs: [{ id, key, status }] }`; `409 { error, keys }` if a key exists with another input |
| `DELETE /apps/:appId/generation/artifacts/:jobId` | | `{ withdrawn: 1 }`; the job reopens |
| `PUT /apps/:appId/generation/artifacts/:jobId/review` | `{ submissionId, status: 'reviewed' \| 'needs_changes', note? }`; console session of the owner only | `{ review: { status, note, by, at } }`; `409` when `submissionId` is no longer the job's artifact |
| `POST /apps/:appId/generation/contributors/:userId/block` | | `{ blocked: true, withdrawn: n }` |
| `GET /apps/:appId/generation/sets` | | `{ sets: [{ ...set, counts: { jobs, open, accepted, leased, pending, rejected, withdrawn } }] }`, newest first |
| `GET /apps/:appId/generation/sets/:setId/jobs?status=&review=&cursor=&limit=` | | `{ jobs: [{ id, key, status, inputPreview, inputChars, createdAt, artifact, submissions }], nextCursor }` |
| `GET /apps/:appId/generation/sets/:setId/jobs/:jobId` | | `{ job: { ...as listed, input: { text }, reviews: [{ submissionId, status, note, by, at }] } }`: the whole input, and every review recorded on any version of the job, newest first, from the audit log |
| `GET /apps/:appId/generation/review?setId=` | | `{ items: [{ jobId, setId, key, submissionId, url, metaUrl, bytes, durationMs, acceptedAt, contributor, report, inputPreview, inputChars }] }`: the review queue (#842), accepted artifacts not yet reviewed, those the device reported not good first, then unreported, then reported good, oldest first within each; at most 100 |
| `GET /apps/:appId/generation/contributors` | | `{ autoBlockBelow, autoBlockMinJudged, contributors: [{ contributor, submissions, accepted, judged, good, goodRate, reviewed, needsChanges, reportedGood, reportedNotGood, blocked }] }`, most submissions first |
| `PUT /apps/:appId/generation/settings` | `{ autoBlockBelow: 0-1 \| null }`; console session of the owner only | `{ autoBlockBelow }`; audited |

`formats` is a non-empty subset of `audio/mp4`, `audio/ogg`, `audio/wav`; `maxBytes` at most
25,000,000; `replicas` 1-3. Keys are 1-200 characters of `A-Za-z0-9._:/-`; `text` at most 100,000
characters. `language` is an optional BCP 47 tag of the input text (`en`, `es`, `zh`, `zh-Hans`,
`pt-BR`, …); sets, claimed jobs and
discovery echo it, `null` when the set has none. Verification thresholds default to the language's
characters-per-second band (`zh` and `yue` 2-9, `ja` 3-15, anything else or no language 8-30; see
[Verification](#verification)); `minCharsPerSecond` and `maxCharsPerSecond` override them. Re-sending a job with the same key and input is a no-op that returns its status
(`open` or `accepted`).

Set counts: `open` and `accepted` count jobs by status, `leased` live leases, and `pending`, `rejected`
and `withdrawn` submissions (`withdrawn`: rejected because the owner withdrew the artifact or blocked
its contributor; `rejected` excludes those).

Jobs are ordered by key. `status` is `open` or `accepted`; `review` keeps the accepted jobs whose current version is
`unreviewed`, `reviewed` or `needs_changes`; `limit` is 50 by default, at most 200; pass
`nextCursor` (the page's last key, `null` on the last page) as `cursor`. `inputPreview` is the first 200
characters of the text and `inputChars` its length. `artifact` is `null` or `{ url, submissionId,
durationMs, bytes, contributor, acceptedAt, review }` (`url` as in the manifest; `review` is `{ status,
note, by, at }` or `null` while not reviewed). `submissions` are the job's 5 latest, newest first:
`{ id, contributor, deviceKind, attestation, status, reason, durationMs, createdAt, decidedAt, report,
record }`, where `report` is the contributor's `{ good, note, at }` or null and `record` is the
device's attempt record for that upload (below) or null;
`attempts` are the job's 5 latest attempt records that ended without an upload, each with its
`contributor`. A `contributor` is `{ id, login }` (the user id `block` takes and the GitHub login), or
`null` once the account is deleted.

Contributor: a session delivered to the app (or a console session), or a native companion device
credential (`Bearer ndev_…`). Blocked contributors get `403`.

| Call | Body | Result |
|---|---|---|
| `POST /apps/:appId/generation/claim` | `{ setId?, models: [{ model, modelVersion }] }`; optional header `X-Runner-Id` | `{ job: { id, setId, key, input, model, modelVersion, params, formats, maxBytes, language, leaseToken, leaseExpiresAt } }` or `204` |
| `POST /apps/:appId/generation/jobs/:jobId/lease` | header `X-Lease-Token` | `{ leaseExpiresAt }`; `409 { error, leaseExpiresAt }` at the cap |
| `PUT /apps/:appId/generation/jobs/:jobId/result` | multipart `file` + optional `meta` (JSON object, at most 64 KB); header `X-Lease-Token`; optional `X-Attestation` | `202 { submissionId, status }` |
| `POST /apps/:appId/generation/events` | `{ events: [{ jobId, runner, reason, ...numbers }] }`, 1-50 | `{ recorded }` |
| `GET /apps/:appId/generation/submissions` | | `{ submissions: [{ submissionId, jobId, setId, key, status, reason, bytes, contentType, createdAt, decidedAt, durationMs, report, input: { text }, artifact: { url, metaUrl } \| null }] }`, the caller's own, newest 100 |
| `PUT /apps/:appId/generation/submissions/:submissionId/report` | `{ good: boolean, note? }` (note at most 500 characters) | `{ report: { good, note, at } }`; the caller's own submission only (else `404`), a resend changes it |

- A lease lasts 15 minutes and uploads once. While still generating, the holder can extend it
  (`…/lease`, same `X-Lease-Token`, which does not change) to 15 minutes from now, but never past
  2 hours after the claim; at the cap the call is `409` with the final `leaseExpiresAt`. An invalid,
  used, released or expired lease is `403`. Clients extend when within 5 minutes of expiry
  ([#783](https://github.com/freeappstore-online/platform/issues/783)). Claims, replica counts and
  uploads all use the extended expiry. A user who uploaded for a job is never given it again (even
  after a rejection), so nobody provides two replicas. A lease that ended without an upload gives
  the job back to that user only when it was interrupted
  ([#841](https://github.com/freeappstore-online/platform/issues/841)): the attempt record sent after
  that claim (`…/events`) says `user_stop`, `unplugged`, `thermal`, `background_expired`, `network`,
  `lease_403` or `server_5xx`, or, with no record, the lease ran out without being released (the app
  was closed or killed). Any other end (a skip such as `unsupported` or `too_large`, a failure, the
  2-hour cap) or a lease released by the runner's next claim with no record keeps the job given up.
  Taking it again reuses the user's lease on that job with a new token; the old token can no longer
  extend or upload. A runner that still holds its lease just keeps extending it.
- One open lease per *runner*, the device holding it
  ([#825](https://github.com/freeappstore-online/platform/issues/825)): claiming again releases
  only that runner's previous lease, so a user's phone, tablet and browsers each keep their own. A
  native device (`ndev_`) is its own runner; a browser session names itself with `X-Runner-Id`
  (8-64 characters of `A-Z a-z 0-9 _ -`, otherwise `400`; the SDK sends a random id kept per browser
  install). A session that sends none is one default runner per user. A user holds at most 4 open
  leases across runners; a claim past that is `429`. The lease token alone authorizes extending and
  submitting.
- A job has at most `replicas` open leases plus pending submissions at a time, each a different user.
- Discovery: `GET /generation/open` → `{ apps: [{ appId, oneliner, sets: [{ setId, kind, model,
  modelVersion, params, formats, maxBytes, language, open }] }] }`, the sets with jobs the caller could claim
  now, by app id. `open` counts them under the claim's own rules: not blocked by the app, no
  attestation required, never held by the caller, a free replica slot. Models are not matched: the
  device skips sets it cannot run. A console session or a native device sees every store app;
  `?appId=` narrows to one app and then authenticates exactly like claim (that app's session too,
  `403` if blocked).
- Backlog: `GET /generation/backlog` → `{ jobs: [{ id, appId, key, createdAt, inputPreview,
  inputChars, model, modelVersion }], hasMore }`. Uses discovery's authentication, optional
  `?appId=`, and claim eligibility. Returns at most 100 jobs, oldest first (creation time then
  insertion order), with a 160-character text preview; `hasMore` indicates additional eligible
  jobs. Reading never claims work. Responses are private and not cached. **Up next** on desktop,
  iOS, Android and the console's Generate status page shows this list with manual refresh.
  It includes apps the user has not enabled and models this device may not support; runners still
  apply their choices and capabilities, and other devices can change availability and order.
- `…/events` records how each attempt at a job the caller leased went
  ([#813](https://github.com/freeappstore-online/platform/issues/813),
  [#827](https://github.com/freeappstore-online/platform/issues/827)): one record per lease (a resend
  replaces it, and a job taken again after an interruption is one lease, so its next record replaces
  the earlier one; jobs the caller never leased are ignored). `runner` is `android`, `ios`, `browser` or
  `desktop`; `reason` is the local end: `submitted`, `user_stop`, `unplugged`, `thermal`,
  `background_expired`, `network`, `lease_403`, `lease_cap`, `model_missing`, `model_error`,
  `encode_error`, `too_large`, `unsupported`, `server_4xx`, `server_5xx` or `other`. Optional fields,
  numbers and context only: `error`, `appVersion`, `os`, `device`, `network`, `thermalStart`,
  `thermalEnd` (strings of at most 300 characters), `background`, `chargingStart`, `chargingEnd`
  (booleans), `batteryStart`, `batteryEnd` (0-100), `startedAt`, `wallMs`, `loadMs`, `synthMs`,
  `encodeMs`, `uploadMs`, `cpuMs` (process CPU time), `peakMemMb`, `rtf` (synthesis time over audio
  duration), `bytes`, `durationMs` (non-negative numbers). Any other field is `400`. No text or audio:
  the device keeps the full record (input, output, segments) in its own history, where it can be
  played back; the server already has the text and the upload. Kept 14 days, 1,000 per user per UTC
  day (then `429`). Owners see them in the jobs list.
- `…/submissions` lists only the caller's own submissions (#824). `durationMs` is what
  verification measured (null until then), `report` the caller's own Good / Not good (#831) or null, `input` is the job's input as the claim returned it (so a
  device can show text for jobs another device of the account ran), and `artifact` is the job's
  accepted artifact (absolute URLs, `metaUrl` null without meta) or null. It may come from another
  user's submission: it is this one's only when `status` is `accepted`.
- The `file` part's content type must be one of the set's `formats`, non-empty and at most
  `maxBytes`. Without a valid lease the upload is `403`.
- Submission statuses: `pending`, `accepted`, `rejected` (with `reason`), `superseded` (another
  submission for the job was accepted first). An upload for an already accepted job is `superseded`
  on arrival.

Public (no auth):

- `GET /apps/:appId/generation/sets/:setId/manifest` → `{ artifacts: [{ key, jobId, url, metaUrl?,
  bytes, contentType, durationMs, sha256, model, modelVersion, acceptedAt }] }`, cached 60 s.
- `GET /apps/:appId/generation/artifacts/:jobId` and `…/:jobId/meta`. The manifest URLs carry
  `?v=<sha256 prefix>` and are served `immutable` for a year; a mismatching `v` is `404`, so a
  cached URL always means the same bytes. Without `v` the cache lifetime is one hour.

## Verification

Each pending submission is verified right after upload (in the background) and by a 15-minute cron
that retries anything unfinished, in `packages/backend/src/lib/generation-verify.ts`:

1. **Container**: WAV (PCM header and data chunk), MP4/M4A (boxes tile the file, `mvhd` duration,
   an audio track whose samples all lie inside the file) or Ogg Opus (complete pages, end of stream,
   duration from the last granule). The parsed format must equal the declared content type;
   truncated files are rejected.
2. **Plausibility**: the input text's length divided by the duration must lie within the set's
   characters-per-second band, except that audio up to 3 s is never too long (a two-character
   phrase with silence around it passes). If `meta` has Books-style sentence timings
   (`segments: [[charStart, charEnd, startSec, endSec], …]`), they must be monotonic, inside the text,
   and end within the duration (0.5 s slack).
3. **Replicas**: with `replicas > 1`, a passing submission waits until `replicas` distinct users have
   passing submissions whose durations are within 15% of the earliest one. The earliest becomes the
   artifact; the others are `superseded`. If every replica passed but they disagree, the dissenters
   are rejected so others can claim the job.

**No AI compute checks anything** ([#831](https://github.com/freeappstore-online/platform/issues/831)):
the server checks structure only, and people judge whether audio is good, on the device that made it
and in the console. A failed check sets `rejected` with the reason, deletes the quarantined bytes and
reopens the job for other users. Each submission records the measured duration. When storage fails a
submission stays `pending` and is retried later; after 6 days it is rejected as expired.

## Models and runners

A set may name any `model` and `modelVersion`, but a job is only claimed by a device that runs
exactly that model: a set naming a model no runner supports is accepted and its jobs are never
claimed. Runners today:

| Runner | Model | Format | Params | Voices and languages |
|---|---|---|---|---|
| Android companion ([#731](https://github.com/freeappstore-online/platform/issues/731)) | `kokoro` `v1.0` (sherpa-onnx `kokoro-multi-lang-v1_0`) | `audio/mp4` (AAC-LC 32 kbps, 24 kHz mono; [#798](https://github.com/freeappstore-online/platform/issues/798)) | `{ voice, speed? }` (speed 0.5-2, default 1) | All 54 Kokoro v1.0 voices: English (`af_`, `am_`, `bf_`, `bm_`), Spanish, French, Hindi, Italian, Japanese, Portuguese, Mandarin (`zf_`, `zm_`) |
| iOS companion ([#733](https://github.com/freeappstore-online/platform/issues/733)) | same | same | same | same |
| Browser, `@freeappstore/sdk/generation-kokoro` (Books, console Generate page) | `kokoro` `v1.0` (kokoro-js) | `audio/mp4` (WebCodecs AAC-LC 32 kbps mono, 24 kHz, else 48 kHz where the browser refuses 24 kHz) | same | English voices only |
| FAS desktop app ([#826](https://github.com/freeappstore-online/platform/issues/826), [#837](https://github.com/freeappstore-online/platform/issues/837); `desktop/`, Electron) | same as the phones (`sherpa-onnx-node` in a utility process, CPU) | WebCodecs AAC-LC 32 kbps mono in a hidden window; 48 kHz on macOS, whose Electron build refuses 24 kHz AAC | same | same as the phones |

Model packages each runner downloads, only after the user asks (the phones and desktop also wait for 1,751 MB of free
storage, #792):

| Runners | Package | Download | Installed | Checked | Licence |
|---|---|---|---|---|---|
| Android, iOS, desktop | [`kokoro-multi-lang-v1_0.tar.bz2`](https://github.com/k2-fsa/sherpa-onnx/releases/download/tts-models/kokoro-multi-lang-v1_0.tar.bz2) (sherpa-onnx release asset) | 349,886,476 B | 401,239,297 B | SHA-256 `60703707bc05ccd48d60e1eb723f38b07d6e474795a0b6a588d7220400e0f7a4` before anything is unpacked; a mismatch installs nothing | Apache-2.0 (Kokoro weights) |
| Browser | `onnx-community/Kokoro-82M-v1.0-ONNX` on Hugging Face through kokoro-js 1.2.1 (fp32 for WebGPU, q8 for WebAssembly) | 325,532,232 B / 92,361,116 B | in Cache Storage | Not pinned: the latest revision, no checksum (#788) | Apache-2.0 (Kokoro weights) |

A runner skips any job it would not generate exactly: another model or version, no `audio/mp4` in
`formats`, params other than `voice` and `speed`, or a voice it doesn't have. Language
([#812](https://github.com/freeappstore-online/platform/issues/812)):

- **Android, iOS and desktop** take a set's `language` when it names one: `en` with an English voice, `es` with
  `ef_`/`em_`, or `zh` (any `zh-…` tag) with `zf_`/`zm_`; any other language, or a voice of another
  language, is skipped with reason `language`. A set naming none goes by the voice as before
  (`zf_`/`zm_` are Mandarin). English and Spanish text is split into sentences as Books does;
  Mandarin at 。！？；… (and `. ! ? ;`), with Mandarin number and date reading. Audio under a second
  gets silence at the end, so a two-character phrase such as `对。` passes verification.
- **Browser** speaks English only: `kokoroProblem` skips a set naming a language other than `en`, or
  using a non-English voice, with the reason (for example `language zh: this browser runner speaks
  English only`). Browser Mandarin needs sherpa-onnx
WASM (kokoro-js phonemizes English only); Kokoro v1.1-zh (more Mandarin voices) is held in reserve
([ADR-003](https://github.com/freeappstore-online/platform/blob/main/docs/adr/003-cross-app-community-generation.md#3-approved-model-catalogue)).

To use a model no runner supports (for example better Mandarin TTS), open an issue on
[freeappstore-online/platform](https://github.com/freeappstore-online/platform/issues) naming the model,
version, licence, languages and what your app needs. Models become runnable through the reviewed
catalogue planned in [#788](https://github.com/freeappstore-online/platform/issues/788) (ADR-003):
model id, version, tasks, languages, runtimes, licence, download size and checksum. Devices never
download a model a job names.

Set `language` on sets whose text is not English (#810): it picks the characters-per-second band.

### Browser and desktop runner behaviour

The console's Generate page and the desktop app run the same SDK loop (`Generation.contribute` and
`contributeKokoroApps`; the desktop with its own sherpa-onnx runner in place of the browser's `KokoroRunner`) and behave like the phones ([#819](https://github.com/freeappstore-online/platform/issues/819)):

- **Order**: one job from each opted-in app in turn; an app leaves the run when it has no job for this user or a
  job of it is not submitted (skipped, lease ran out, failed). The opt-ins are read again before each turn.
- **Retries**: a claim that fails transiently (network failure, `5xx`, `408`, or `429` with `Retry-After`) is tried
  again after 2 s doubling to 60 s (or `Retry-After`) for up to a minute. An upload sends the same file again, extending
  the lease as due, until 30 s before the lease ends, then the job is recorded failed. Nothing is generated twice.
- **Lease**: extended once within 5 minutes of expiry, on every message from the model worker (each sentence, and
  each download step) and on a timer. A `403` or `409` stops extending.

### Running in the background

Synthesis and AAC encoding run in a dedicated Web Worker; the page's main thread only relays messages and makes
the API calls. Because the lease is renewed on the worker's messages, not only on a timer, it holds where the
page's own timers are throttled.

**Chrome and Edge (Chromium), tab or installed console**, from Chrome's documentation and source:

- A hidden page's timers run at most once a second, and after 5 minutes hidden, chained timers once a minute
  ([timer throttling](https://developer.chrome.com/blog/timer-throttling-in-chrome-88)). Dedicated worker
  timers are not throttled (Blink's `kDedicatedWorkerThrottling` is off by default), so synthesis runs at full
  speed. A minimised installed console is hidden like a background tab (Chrome's freezing code has no
  installed-app exemption).
- With **Energy Saver** on, Chrome freezes pages hidden and silent for over 5 minutes that use a lot of CPU,
  workers included ([freezing on Energy Saver](https://developer.chrome.com/blog/freezing-on-energy-saver)). A page
  holding a Web Lock is exempt (`CannotFreezeReason::kHoldingWebLock`), so the Generate page holds the
  `fas:generate` lock while it runs. The lock also keeps the run to one tab: a second console tab says another one
  is generating.
- **Memory Saver** may discard a background tab; a Web Lock does not prevent it. An installed console's window is
  never discarded on desktop (`CannotDiscardReason::kWebApp`). A discarded tab loses the job in hand (its lease runs
  out on the server; another device takes it later).
- The screen wake lock is released whenever the page is hidden; the page takes it again when it is shown. Without
  it the computer may sleep, which stops everything.

What was tested (#826, macOS 15, against a local stand-in API, with the SDK's runner and worker as the console
builds them): in Electron 45 (Chromium 156) a page in a window that was shown and then hidden, with background
throttling on, so `document.visibilityState` was `hidden` and Blink throttled it as a background tab. A 12-sentence
job (WebAssembly) took 336 s hidden and 326 s visible and was uploaded both times. In a longer WebGPU job, after
5 minutes hidden the page's own 1-second timer fired once a minute (a 51 s gap), while the worker kept finishing a
sentence every ~10 s; the lease, due 6 minutes after the claim, was extended 0.5 s after it became due, on a worker
message (the throttled timer would have fired about 48 s later). The run was stopped there; the upload path was
covered by the shorter jobs and by the desktop's end-to-end test. Not tested: Chrome's own browser-level policies
(Energy Saver freezing, Memory Saver discarding), because Playwright-driven Chrome on this Mac never reported the
page hidden (its display was off, so windows were never occluded); what is written about them above is from Chrome's
documentation and source, not observed. A first run's model download (WebAssembly, 92 MB) took about two minutes.

**Safari** (26+) has WebCodecs `AudioEncoder`. It throttles hidden pages' timers and lowers background processes'
priority but, since 2023, does not suspend them on macOS
([WebKit 254535](https://bugs.webkit.org/show_bug.cgi?id=254535)). WebKit's AAC encoder gave MP4 files no valid
decoder config, so their audio played silent ([WebKit 302253](https://bugs.webkit.org/show_bug.cgi?id=302253),
fixed in WebKit in October 2026); a Safari without the fix produces uploads that fail verification. Not tested
here: Safari's behaviour in the background and in a Dock web app is not documented that we could find.

**Firefox** has no WebCodecs AAC encoder, so the page says it can't generate (as it did before).

**Limits no page can avoid**: the browser must stay open and the computer awake; closing the tab or window,
quitting the browser, sleep, a Memory Saver discard or a crash ends the run and loses the job in hand (its lease
expires; nothing partial is uploaded). For generating with no window open, use the desktop app, which generates in a
utility process (encoding in a hidden window with background throttling turned off) and keeps going from the tray.

## Limits

- 5,000 submissions per app per UTC day (it bounds storage); there is no per-user cap, contributors
  set their own limits on the device ([#830](https://github.com/freeappstore-online/platform/issues/830)). Uploads
  past it are `429` (no `Retry-After`), and once it is reached a claim is `429` too and leases nothing, so a runner
  never generates a job it cannot upload ([#828](https://github.com/freeappstore-online/platform/issues/828)).
- Leases: 15 minutes, extendable to at most 2 hours after the claim; one open per runner, at most 4 per user.
- Jobs: 1-500 per request; text at most 100,000 characters (8 MB per request). Sets: `maxBytes` at most 25 MB.

## Storage and lifecycle

Private R2 bucket `fas-generated`, read only through the API. Quarantine `q/<app>/<job>/<submission>`
expires after 7 days (`packages/backend/config/generated-lifecycle.json`, applied by the backend
deploy workflow). Artifacts `a/<app>/<job>/<submission>` are permanent until withdrawn.

The 15-minute reaper (`pruneGenerated`) deletes artifacts, sets, jobs, submissions, blocks and audit
rows of apps that were unpublished or deleted, and rejects submissions still pending after 6 days
(their quarantined bytes are about to expire). Deleting an account removes that user's leases,
submissions and attempt records and clears the contributor on their accepted artifacts, which stay public.

What a contributor's device sends, who sees it and how long it is kept, in one place:
[Desktop and phone apps: where data goes](device-data.md#contribute-community-generation).
