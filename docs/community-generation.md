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
latest submissions (status, reason, WER, contributor, device and attestation) and can withdraw an
artifact or block a contributor. Highlighting follows the whole text, which the tab reads with
`GET …/sets/:setId/jobs/:jobId` when the audio starts.

Any signed-in creator can generate for every store app from the console's **Generate** page
(`freeappstore.online/app/generate`, desktop browsers with WebCodecs AAC): it lists the apps with open
work from discovery, runs Kokoro sets (`kokoro` `v1.0`, `audio/mp4`) for the apps they opt in to, after
they agree to download the model. It uses the SDK's shared browser runner,
`@freeappstore/sdk/generation-kokoro` (also used by Books), and runs only while the window is open.
The page has three tabs (#820): **Status** (running, idle or paused and why; the current app, job,
sentence n/N and speed; Start/Stop; today's accepted, checking, rejected and not-done counts, which
open Activity filtered), **Activity** (the account's `mySubmissions()` for every app it may have worked
for, plus this browser's own run records in localStorage for jobs it skipped, stopped or failed;
filter by status and app, grouped by day; a row opens its detail with the verdict and reason, size,
duration, and Play with sentence highlighting for accepted ones, from the set's public manifest) and
**Settings** (apps with open work and the per-app opt-in, the model download/delete, storage used).

## API (base `https://api.freeappstore.online/v1`)

Owner: the app owner's session (the app's own or a console session), or a GitHub Actions OIDC token
(audience `https://api.freeappstore.online`) from `refs/heads/main` of the repository the app is
pinned to. A repository is pinned by the app's first keyless deploy.

| Call | Body | Result |
|---|---|---|
| `POST /apps/:appId/generation/sets` | `{ kind: 'tts', model, modelVersion, params, formats, maxBytes, replicas, requireAttestation?, language?, minCharsPerSecond?, maxCharsPerSecond?, maxWer? }` | `201 { set }` |
| `POST /apps/:appId/generation/sets/:setId/jobs` | `{ jobs: [{ key, input: { text } }] }`, 1-500 | `{ jobs: [{ id, key, status }] }`; `409 { error, keys }` if a key exists with another input |
| `DELETE /apps/:appId/generation/artifacts/:jobId` | | `{ withdrawn: 1 }`; the job reopens |
| `POST /apps/:appId/generation/contributors/:userId/block` | | `{ blocked: true, withdrawn: n }` |
| `GET /apps/:appId/generation/sets` | | `{ sets: [{ ...set, counts: { jobs, open, accepted, leased, pending, rejected, withdrawn } }] }`, newest first |
| `GET /apps/:appId/generation/sets/:setId/jobs?status=&cursor=&limit=` | | `{ jobs: [{ id, key, status, inputPreview, inputChars, createdAt, artifact, submissions }], nextCursor }` |
| `GET /apps/:appId/generation/sets/:setId/jobs/:jobId` | | `{ job: { ...as listed, input: { text } } }`, the whole input |

`formats` is a non-empty subset of `audio/mp4`, `audio/ogg`, `audio/wav`; `maxBytes` at most
25,000,000; `replicas` 1-3. Keys are 1-200 characters of `A-Za-z0-9._:/-`; `text` at most 100,000
characters. `language` is an optional BCP 47 tag of the input text (`en`, `es`, `zh`, `zh-Hans`,
`pt-BR`, …) whose primary subtag Whisper must know (otherwise `400`); sets, claimed jobs and
discovery echo it, `null` when the set has none. Verification thresholds default to the language's
characters-per-second band (`zh` and `yue` 2-9, `ja` 3-15, anything else or no language 8-30) and an
error rate of 0.25 (see [Verification](#verification)); `minCharsPerSecond`, `maxCharsPerSecond` and
`maxWer` override them. Re-sending a job with the same key and input is a no-op that returns its status
(`open` or `accepted`).

Set counts: `open` and `accepted` count jobs by status, `leased` live leases, and `pending`, `rejected`
and `withdrawn` submissions (`withdrawn`: rejected because the owner withdrew the artifact or blocked
its contributor; `rejected` excludes those).

Jobs are ordered by key. `status` is `open` or `accepted`; `limit` is 50 by default, at most 200; pass
`nextCursor` (the page's last key, `null` on the last page) as `cursor`. `inputPreview` is the first 200
characters of the text and `inputChars` its length. `artifact` is `null` or `{ url, durationMs, bytes,
contributor, acceptedAt }` (`url` as in the manifest). `submissions` are the job's 5 latest, newest
first: `{ id, contributor, deviceKind, attestation, status, reason, wer, durationMs, createdAt,
decidedAt }`. A `contributor` is `{ id, login }` (the user id `block` takes and the GitHub login), or
`null` once the account is deleted.

Contributor: a session delivered to the app (or a console session), or a native companion device
credential (`Bearer ndev_…`). Blocked contributors get `403`.

| Call | Body | Result |
|---|---|---|
| `POST /apps/:appId/generation/claim` | `{ setId?, models: [{ model, modelVersion }] }` | `{ job: { id, setId, key, input, model, modelVersion, params, formats, maxBytes, language, leaseToken, leaseExpiresAt } }` or `204` |
| `POST /apps/:appId/generation/jobs/:jobId/lease` | header `X-Lease-Token` | `{ leaseExpiresAt }`; `409 { error, leaseExpiresAt }` at the cap |
| `PUT /apps/:appId/generation/jobs/:jobId/result` | multipart `file` + optional `meta` (JSON object, at most 64 KB); header `X-Lease-Token`; optional `X-Attestation` | `202 { submissionId, status }` |
| `GET /apps/:appId/generation/submissions` | | `{ submissions: [{ submissionId, jobId, setId, key, status, reason, bytes, contentType, createdAt, decidedAt }] }`, newest 100 |

- A lease lasts 15 minutes and uploads once. While still generating, the holder can extend it
  (`…/lease`, same `X-Lease-Token`, which does not change) to 15 minutes from now, but never past
  2 hours after the claim; at the cap the call is `409` with the final `leaseExpiresAt`. An invalid,
  used, released or expired lease is `403`. Clients extend when within 5 minutes of expiry
  ([#783](https://github.com/freeappstore-online/platform/issues/783)). Claims, replica counts and
  uploads all use the extended expiry. A user holds one open lease: claiming again releases
  the previous one. A user is never given the same job twice (even after a release or rejection).
- A job has at most `replicas` open leases plus pending submissions at a time, each a different user.
- Discovery: `GET /generation/open` → `{ apps: [{ appId, oneliner, sets: [{ setId, kind, model,
  modelVersion, params, formats, maxBytes, language, open }] }] }`, the sets with jobs the caller could claim
  now, by app id. `open` counts them under the claim's own rules: not blocked by the app, no
  attestation required, never held by the caller, a free replica slot. Models are not matched: the
  device skips sets it cannot run. A console session or a native device sees every store app;
  `?appId=` narrows to one app and then authenticates exactly like claim (that app's session too,
  `403` if blocked).
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
3. **Content**: Workers AI Whisper (`@cf/openai/whisper-large-v3-turbo`) transcribes the audio,
   told the set's language (its primary subtag, e.g. `zh`) when the set has one, and the transcript
   is compared with the input text by word error rate (lowercased words, punctuation and diacritics
   dropped). Scripts written without spaces (Han, Hiragana, Katakana, Thai, Lao, Khmer, Myanmar)
   count each letter as a token, so their error rate is a character error rate, and Traditional
   Chinese is read as Simplified (OpenCC's character table), so either form Whisper writes matches.
   Mandarin phrases from 2 to 12 characters spoken by macOS `say` and transcribed by the real model
   passed at an error rate of 0 to 0.1, with or without the language hint (#810). The transcript
   must be within `maxWer`, except that a reference of at most 3 tokens (after normalisation, any
   script) passes with one edit at most that keeps a token of it: `对。` heard as `对呀` or `是的。`
   heard as `是` passes, `对。` heard as `好` or nothing fails (#816; one extra character on a
   one-character reply is an error rate of 1). The same rule applies to sampled windows and replica
   agreement. Audio up to 60 s is transcribed whole. Longer audio is checked as three
   20-second windows, each matched against the best-fitting stretch of the text. Window positions
   are random fractions of the audio, drawn once per job (devices never see them), so every replica
   of a job is sampled at the same points. MP4 windows are re-framed as ADTS AAC, Ogg windows keep
   the Opus header pages. Whisper accepts all of these: whole M4A (AAC-LC) and Ogg Opus files and
   both kinds of window were checked against the real model (#784).
4. **Replicas**: with `replicas > 1`, a passing submission waits until `replicas` distinct users have
   passing submissions that agree with the earliest one: durations within 15%, and what Whisper
   heard matches as in step 3 (whole transcripts against each other; for long audio each window against
   the earliest submission's same window, ignoring the words cut at the window edges). This reuses
   the transcripts from step 3, so replicas cost no extra Whisper calls. The earliest becomes the
   artifact; the others are `superseded`. If every replica passed but they disagree, the dissenters
   are rejected so others can claim the job.

A failed check sets `rejected` with the reason, deletes the quarantined bytes and reopens the job for
other users. Each submission records the measured duration and word error rate.

Verification is capped at 2,000 per app per UTC day (Workers AI cost). Over the budget, or when
Whisper fails, a submission stays `pending` and is retried later; after 6 days it is rejected as
expired.

## Models and runners

A set may name any `model` and `modelVersion`, but a job is only claimed by a device that runs
exactly that model: a set naming a model no runner supports is accepted and its jobs are never
claimed. Runners today:

| Runner | Model | Format | Params | Voices and languages |
|---|---|---|---|---|
| Android companion ([#731](https://github.com/freeappstore-online/platform/issues/731)) | `kokoro` `v1.0` (sherpa-onnx `kokoro-multi-lang-v1_0`) | `audio/mp4` (AAC-LC 32 kbps, 24 kHz mono; [#798](https://github.com/freeappstore-online/platform/issues/798)) | `{ voice, speed? }` (speed 0.5-2, default 1) | All 54 Kokoro v1.0 voices: English (`af_`, `am_`, `bf_`, `bm_`), Spanish, French, Hindi, Italian, Japanese, Portuguese, Mandarin (`zf_`, `zm_`) |
| iOS companion ([#733](https://github.com/freeappstore-online/platform/issues/733)) | same | same | same | same |
| Browser, `@freeappstore/sdk/generation-kokoro` (Books, console Generate page) | `kokoro` `v1.0` (kokoro-js) | `audio/mp4` (WebCodecs AAC-LC 32 kbps mono, 24 kHz, else 48 kHz where the browser refuses 24 kHz) | same | English voices only |

A runner skips any job it would not generate exactly: another model or version, no `audio/mp4` in
`formats`, params other than `voice` and `speed`, or a voice it doesn't have. Language
([#812](https://github.com/freeappstore-online/platform/issues/812)):

- **Android and iOS** take a set's `language` when it names one: `en` with an English voice, `es` with
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

Set `language` on sets whose text is not English (#810): it tells Whisper the language and picks the
characters-per-second band; text in scripts without spaces is compared by character error rate
whether or not it is set.

## Limits

- 200 submissions per user per UTC day across all apps; 5,000 per app per UTC day.
- Leases: 15 minutes, extendable to at most 2 hours after the claim; one open per user.
- Verifications: 2,000 per app per UTC day.
- Jobs: 1-500 per request; text at most 100,000 characters (8 MB per request). Sets: `maxBytes` at most 25 MB.

## Storage and lifecycle

Private R2 bucket `fas-generated`, read only through the API. Quarantine `q/<app>/<job>/<submission>`
expires after 7 days (`packages/backend/config/generated-lifecycle.json`, applied by the backend
deploy workflow). Artifacts `a/<app>/<job>/<submission>` are permanent until withdrawn.

The 15-minute reaper (`pruneGenerated`) deletes artifacts, sets, jobs, submissions, blocks and audit
rows of apps that were unpublished or deleted, and rejects submissions still pending after 6 days
(their quarantined bytes are about to expire). Deleting an account removes that user's leases and
submissions and clears the contributor on their accepted artifacts, which stay public.
