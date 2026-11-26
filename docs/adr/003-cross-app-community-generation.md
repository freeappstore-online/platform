# ADR-003: Cross-app community generation and private pilot

## Status

Proposed - 2026-11-26. Design for #786 (epic #727). Needs owner acceptance on #786
before #788 and #789 start. Changes no shipped API.

## Context

Community generation ships as one public TTS path: `kind: 'tts'`, `{ text }` input,
public verification of the file's structure (no AI compute since #831; people judge quality on
the device and in the console), and a write-once public artifact per job
([community-generation.md](../community-generation.md), migrations 0053/0054,
`packages/backend/src/routes/generation.ts`, `packages/sdk/src/generation.ts`,
Android `Generation.kt` / `ContributeWorker.kt` / `Kokoro.kt`). Books is its first user.

The next consumers are language apps. Sayback (`freeappstore-online/sayback`) ships an
`en-zh-v1` phrase pack (`en`, `zh`, `pinyin`) with Ogg audio made locally with Kokoro v1.0
(`zf_xiaobei`), labelled unreviewed. Dialogue ships unreviewed fixture MP3s for Mandarin
role-play lines. Both need English to Mandarin text and short Mandarin speech.

The first rollout is a private pilot. Serge runs one small batch on a physical Pixel, a
physical iPhone and a browser. Language quality is reviewed manually only. No automated
pronunciation grading, translation scoring, semantic gate or "verified correct" label is
built. Integrity and provenance checks report only that usable bytes came back.

Two facts in the current code shape the design:

- The legacy claim matches any open job in the app by `model` and `modelVersion`. A private
  Kokoro v1.0 job in the existing tables would be offered to every shipped Android client.
- The manifest, artifact routes, `verifyPending` and `acceptSubmission` read
  `generation_sets`, `generation_submissions` and `generation_artifacts`. A private row
  placed in those tables could be verified and published by mistake.

## Decision

### 1. Private pilot data lives in separate tables and routes

The public path stays exactly as it is: tables, routes, verifier, limits, SDK methods and
Android behaviour. Pilot data uses new tables and a separate route prefix. No query on the
public path can select a private row, so isolation does not depend on remembering a
`WHERE visibility = 'public'` filter.

| Table (new migration) | Holds |
|---|---|
| `generation_pilot_sets` | `id, app_id, owner_id, kind, schema_version, model, model_version, params, formats, max_bytes, created_by, created_at` |
| `generation_pilot_jobs` | `id` (sha256 of set + key + input + model/version/params), `set_id, app_id, key, input, status` (`open`, `leased`, `done`), `created_at` |
| `generation_pilot_leases` | `job_id, user_id, app_id, token_hash, state` (`open`, `used`, `released`, `expired`), `created_at, expires_at` (server time) |
| `generation_pilot_results` | One immutable row per result version: `id, app_id, job_id, version, user_id, device_kind, platform, model, model_version, runtime, object_key, bytes, content_type, sha256, duration_ms, integrity` (`checked`, `failed`), `integrity_reason, created_at`. `UNIQUE (job_id, version)` |
| `generation_reviews`, `generation_review_events` | Manual review state per result version and its append-only history (section 6) |

Objects go to the existing private `fas-generated` bucket under `p/<app>/<job>/<resultId>`.
This is a prefix that nothing on the public path reads.

Routes live under `/v1/apps/:appId/generation/private/…`. They are disabled unless the
backend variable `GENERATION_PILOT` (JSON `{ owners: [userId], apps: [appId] }`) lists both
the app and the caller. Outside that list every private route returns `404`.

| Call | Who | Notes |
|---|---|---|
| `POST …/private/sets` | Console owner session | Typed set (section 2). The model must be `approved` in the catalogue |
| `POST …/private/sets/:setId/jobs` | Console owner session | 1-50 jobs. Same key with a different input is `409` (as now) |
| `POST …/private/claim` | Owner, via console session or `ndev_` whose `user_id` is `apps.owner_id` | Body: capabilities (section 3). Returns `{ job }` with a lease token, or `204` |
| `POST …/private/jobs/:jobId/release` | Lease holder (`X-Lease-Token`) | Ends the lease and reopens the job. Nothing is counted |
| `PUT …/private/jobs/:jobId/result` | Lease holder | Multipart `file`. Creates the next result version |
| `POST …/private/jobs/:jobId/regenerate` | Console owner session | Reopens a `done` job. The next result is a new, unreviewed version |
| `GET …/private/jobs`, `GET …/private/results/:resultId` | Console owner session, or the owner's `ndev_` for the list only | Preview with `Cache-Control: private, no-store`, `nosniff`, `Content-Disposition: inline` |
| `GET/PUT …/private/results/:resultId/review` | Console owner session (`requireConsoleAppOwner`) | Section 6 |

Owner means `apps.owner_id` when the request is made, not when the set was created.
If ownership transfers, the old owner loses access and the new owner gets none until
added to `GENERATION_PILOT`. Pilot routes never accept GitHub OIDC or app-audience sessions:
an app's own page cannot read or write private results.

Leases differ from the public path in two ways, because the pilot has a single contributor:
a released or expired lease reopens the job for the same owner, and only one lease can be
open per job. Leases still last 15 minutes and are bound to app, job, user and token hash.
The token is single-use, and only server time is used. Pilot jobs are short phrases
(at most 500 characters), so they finish well inside the lease. Lease extension (#783) is
reused when it lands; the pilot does not depend on it.

A retried upload with the same lease and identical bytes returns the existing result.
Different bytes under a used lease get `403`, and a reused or expired lease gets `403`.

### 2. Typed job schemas, with legacy `tts` unchanged

```ts
type LangTag = 'en' | 'zh-Hans';            // BCP 47; the catalogue lists what each model supports

interface TextToAudioV1 {                    // kind 'text-to-audio', schemaVersion 1
  input: { text: string; lang: LangTag };    // text at most 500 chars in the pilot
  params: { voice: string; speed?: number }; // validated against the catalogue's voices for lang
  formats: ('audio/mp4' | 'audio/wav')[];    // result: one audio file
}

interface TextToTextV1 {                     // kind 'text-to-text', schemaVersion 1
  input: { text: string; sourceLang: LangTag; targetLang: LangTag };
  params: Record<string, never>;             // no free parameters in v1
  formats: ['application/json'];             // result: UTF-8 JSON { text: string }, at most 4 KB
}
```

- Legacy `kind: 'tts'` is defined as text-to-audio schema 0: input `{ text }`, no `lang`,
  public pipeline. Its create, claim, result, manifest and artifact routes, its fields and
  its statuses do not change. Shipped Android and SDK clients keep sending
  `{ models: [{ model: 'kokoro', modelVersion: 'v1.0' }] }` to the public claim and keep
  working. They never call `…/private/…`, so they never see pilot jobs.
- The new kinds are accepted only on the private path. Whether the public path should
  accept `text-to-text` later is a separate decision, outside this ADR.
- The SDK adds the new types and a `generation.private` namespace. Existing exports and
  `GenerationSetOptions.kind: 'tts'` stay as they are.
- Job identity is the existing rule (sha256 of set, key, canonical input and model/version/params),
  so re-sending a job is idempotent.

Integrity checks on upload (every result): valid lease; content type in `formats`; size
non-zero and at most `max_bytes`. Audio must parse as WAV or MP4, reusing the container
parsers in `generation-verify.ts`; the duration is recorded but not judged. Text must be
valid UTF-8 JSON of exactly `{ text }` with a non-empty string, no control characters other
than `\n`, and a size limit. Characters-per-second bands, replicas and language checks are not
run on private results, and no AI compute checks anything on FAS (#831). A failed check records `integrity: 'failed'` with a
reason, keeps the bytes for at most 7 days, and reopens the job.

### 3. Approved model catalogue

The catalogue is a reviewed, versioned file at `packages/backend/config/generation-models.json`.
Changes land only by commit to `main`, and it is served read-only at `GET /v1/generation/models`.
Each entry is immutable once published. A change means a new `version`.

| Field | Meaning |
|---|---|
| `model`, `version` | Exactly what sets and claims carry |
| `kinds` | `text-to-audio` and/or `text-to-text` (legacy `tts` maps to `text-to-audio`) |
| `languages` | TTS: languages with their voices. Translation: `[sourceLang, targetLang]` pairs |
| `licence` | SPDX ID, primary source URL, attribution text, redistribution note |
| `files` | `[{ url, bytes, sha256 }]` at an immutable URL (release asset or Hugging Face `resolve/<commit>`) |
| `downloadBytes`, `installedBytes` | Shown before consent |
| `runtimes` | Per `android`, `ios`, `web`: runtime and pinned version, plus `supported`, `unproven` or `unsupported` |
| `state` | `approved`, `disabled` (no new claims, cache kept) or `revoked` (no claims, clients delete the cache) |
| `approvedBy`, `approvedAt`, `notes` | Owner approval record |

Rules:

- A job can never name a URL, file or code. Clients download only catalogue `files`.
  They verify size and sha256 before unpacking (as `KokoroModel.install` does now) and
  reject path traversal, links and devices in archives.
- Download needs explicit consent showing the size. Packages live in app-private,
  no-backup storage: Android `noBackupFilesDir`, iOS Application Support with
  `isExcludedFromBackup`, web OPFS/Cache Storage. Users can delete a package. A revoked
  package is deleted on the next sync.
- Private claims send `{ platform, runtimes: [{ model, version, runtime }], kinds, languages }`.
  The server matches the set's model/version against an `approved` catalogue entry. That
  entry's runtime for the platform must be `supported`, and the job's languages, voice and
  format must be ones the entry lists. A claim with `setId` that fails any check returns
  `409 { error: 'incompatible', reason }`. Without `setId` an incompatible job is skipped,
  and `204` means no compatible work. The check fails closed if the catalogue is missing.
- During the pilot the public path does not check the catalogue. Books' `kokoro`/`v1.0`
  sets keep working whether or not the catalogue is checked.

Pilot entries. Licences were checked against primary sources on 2026-11-26:

| Use | Package | Licence (source) | Files | Android | iOS | Web |
|---|---|---|---|---|---|---|
| Mandarin and English TTS | `kokoro` / `v1.0`: Kokoro-82M v1.0 as sherpa-onnx `kokoro-multi-lang-v1_0`. Voices `zf_xiaobei`, `zf_xiaoni`, `zf_xiaoxiao`, `zf_xiaoyi`, `zm_yunjian`, `zm_yunxi`, `zm_yunxia`, `zm_yunyang`, `af_heart` | Apache-2.0: [hexgrad/Kokoro-82M](https://huggingface.co/hexgrad/Kokoro-82M) card and [hexgrad/kokoro LICENSE](https://github.com/hexgrad/kokoro/blob/main/LICENSE). Runtime sherpa-onnx Apache-2.0 ([LICENSE](https://github.com/k2-fsa/sherpa-onnx/blob/master/LICENSE)) | `https://github.com/k2-fsa/sherpa-onnx/releases/download/tts-models/kokoro-multi-lang-v1_0.tar.bz2`, 349,886,476 B, `60703707bc05ccd48d60e1eb723f38b07d6e474795a0b6a588d7220400e0f7a4`, 401,239,297 B installed | supported (shipped, #731) | sherpa-onnx iOS via #733: unproven | unproven: sherpa-onnx WASM has a Kokoro config (`wasm/tts/sherpa-onnx-tts.js`), but no build loads an external package yet. `kokoro-js` is English-only (its `phonemize.js` handles only `a`/`b`) |
| English to Mandarin translation | `opus-mt-en-zh` / `xenova-046f55a-q8`: Helsinki-NLP OPUS-MT eng-zho (Marian), ONNX conversion `Xenova/opus-mt-en-zh` at commit `046f55aec303cdee3e0318604406d4df20f1e8ea`. Output needs the target token `>>cmn_Hans<<` | Apache-2.0: [Helsinki-NLP/opus-mt-en-zh](https://huggingface.co/Helsinki-NLP/opus-mt-en-zh) card (`license: apache-2.0`). The Xenova conversion declares no licence and is treated as a derivative of the Apache-2.0 upstream; attribution to Helsinki-NLP / OPUS-MT. Runtimes: Transformers.js Apache-2.0, ONNX Runtime MIT (PyPI metadata), SentencePiece Apache-2.0 | `onnx/encoder_model_quantized.onnx` 52,899,742 B `d3b7912bf6a9bd27e4c074c2df91d4ff3d5b4bc5f7f6c8d7cc9c805c98fbafee`; `onnx/decoder_model_merged_quantized.onnx` 60,212,804 B `023be4f841f4c47cd65fffcbaa81c0d99d7f7e0138f7ba0e03fa220a4e688aff`; `tokenizer.json` 6,380,952 B `d0c7da27056e8f42adce9e76d8e792e5daa64e15f5acd2e7aabf0121877dd4c1`; `source.spm` 806,435 B `5775ddc9e3ff2fae91554da56468ad35ff56edaba870fea74447bc7234bfdaa8`; `target.spm` 804,600 B `81dc94efa84e4025ef38d25d5d07429fe41e3eb29d44003f1db6fe98487b0052`; `config.json` `4727d122…`, `generation_config.json` `b743baab…`, `tokenizer_config.json` `a914596e…`. About 121 MB | ONNX Runtime Android + SentencePiece: unproven | ONNX Runtime iOS + SentencePiece: unproven | Transformers.js: supported (the published pipeline for this repo) |

Considered and not chosen for the pilot:

- `facebook/nllb-200-distilled-600M` is CC-BY-NC-4.0 (non-commercial), so it is excluded.
- `facebook/m2m100_418M` (MIT) and `Qwen/Qwen2.5-0.5B-Instruct` (Apache-2.0) are larger and
  have no advantage for short phrases.
- Kokoro v1.1-zh (Apache-2.0, [card](https://huggingface.co/hexgrad/Kokoro-82M-v1.1-zh);
  sherpa-onnx `kokoro-multi-lang-v1_1.tar.bz2`, 364,855,331 B,
  `b78e1ac42b852e839cceaafbe88f66806bf5860992d1d7b9a3f2ad1198427aed`) adds 100 Mandarin
  speakers. It is the next candidate if the manual review finds v1.0 tones poor. It is not
  in the pilot.
- `opus-mt-zh-en` is CC-BY-4.0. It is not needed, because the pilot direction is English to
  Mandarin only.

Packages are fetched from the upstream pinned URLs, so the platform does not redistribute
weights in the pilot. Hosting a mirror, and the attribution and NOTICE that a mirror needs,
is a decision for after the pilot.

### 4. Contributor controls

One contributor view per device lists the opted-in apps, their compatible private jobs,
the installed packages, progress and the current reason for waiting. On Android it is the
Contribute tab. On iOS it is the companion (#733). On the web it is a console page at
`freeappstore.online/app/contribute`, signed in with the console session. Each app is still
queried separately, so no cross-app server endpoint exists. Opting in is per app and never
automatic. A durable global pause and stop (device storage) blocks new claims and network
downloads, releases any open lease, and survives restarts. Turning the server pilot flag
off is a hard stop for every device.

Budgets count model downloads (including retries and partial downloads), job inputs,
results and API calls. Downloads resume with HTTP `Range`, so an interrupted download does
not spend its bytes twice. A budget preflight runs before every claim and download: the
next unit must fit, otherwise work waits. Server-side, the existing daily upload counters
apply to private results as well. A released or interrupted job does not use the
allowance, because counters are bumped only when an upload is accepted.

The tables below list each control by platform. "Hard" means the platform or our code
enforces the limit. "Best-effort" means we react to a signal that may be missing or late.
"None" means it cannot be offered and the UI says so.

| Control | Android (WorkManager) | iOS (#733) | Web (console page) |
|---|---|---|---|
| Per-app opt-in, global pause/stop | Hard | Hard | Hard while the page is open. Stored in IndexedDB, so it survives reloads |
| Server kill switch (`GENERATION_PILOT`) | Hard | Hard | Hard |
| Unmetered network only | Hard at start (`NetworkType.UNMETERED`). The worker stops when the constraint is lost | Hard per request: `URLSession` `allowsExpensiveNetworkAccess = false` and `allowsConstrainedNetworkAccess = false`. `BGProcessingTask` cannot require unmetered | Best-effort: `navigator.connection` exists in Chromium only. Elsewhere the user confirms the network type, and the UI says so |
| Charging only | Hard (`setRequiresCharging`) | Hard for background work (`requiresExternalPower`). Foreground: best-effort (`UIDevice.batteryState`) | Best-effort: Battery Status API only in Chromium. Otherwise none |
| Byte budget (downloads + uploads) | Hard: our client counts and stops before the next unit | Hard (same) | Hard (same), while open |
| Bandwidth throttle | Hard for our own streams (read-rate limit) | Hard for our own streams | Hard for our own `fetch` streams |
| Parallelism | Hard: one job at a time, `numThreads` ≤ 4 (as now) | Hard (same) | Hard: one Web Worker, one job |
| Runtime per job and per run | Hard: lease margin plus a per-run cap. WorkManager's 10-minute limit applies unless foreground | Hard on our side. The OS ends background tasks at will (expiration handler) | Hard while open. A hidden tab may be throttled |
| Low battery | Hard at start (`setRequiresBatteryNotLow`). Mid-run: best-effort level check | Best-effort (battery level, Low Power Mode) | Best-effort (Chromium) or none |
| Thermal | Best-effort: `PowerManager.getCurrentThermalStatus()`; pause at `THERMAL_STATUS_MODERATE` or above | Best-effort: `ProcessInfo.thermalState`; pause at `.serious` or above | Best-effort: Compute Pressure API (Chromium). Otherwise none |
| Storage | Hard: refuse a download that would leave less than 1 GB free; `setRequiresStorageNotLow` | Hard: same check with `volumeAvailableCapacityForImportantUsage` | Best-effort: `navigator.storage.estimate()` and `persist()`; the browser may evict |
| Work after leaving | OS schedules, as now | Only in OS-granted windows; no guarantee | None: no claim or generation after the tab closes |

No exact CPU percentage is promised on any platform. Interruption at any point is safe.
Unfinished work releases its lease (or lets it expire), and the job reopens for the owner.
A job is never uploaded twice from one lease, and a partial result is never uploaded.

iOS reaches the private routes through an explicit path allowlist added next to the
`/native/` check in `FasApi.endpoint`. The allowlist covers only `claim`, `release`,
`result` and the job list under `/apps/<id>/generation/private/`. Any other path still
fails, and a test covers that.

### 5. Private artifact lifecycle

`open` → `leased` → result uploaded (version n, `integrity: checked` or `failed`) → `done`
→ optionally `regenerate` → `open` → version n+1. Each version is immutable. A review is
attached to one version and is never inherited.

Private output can never reach a public manifest, for these reasons:

- No code path writes pilot results into `generation_artifacts`, `generation_submissions`
  or the `a/` and `q/` prefixes. `acceptSubmission` and `verifyPending` read only the
  public tables.
- Manifest and artifact routes resolve set and job IDs from public tables, so a pilot ID
  returns `404`.
- No "publish" or "promote" operation exists for pilot results. Publishing anything
  publicly later needs its own approved design, and a review never triggers it.
- Tests assert each of the points above, including after a successful private generation
  and after a review.

Retention: pilot results, reviews and objects are kept until the owner deletes them, or
for 180 days after creation, whichever comes first. `pruneGenerated` also removes them when
the app is unpublished or deleted, when the owner's account is deleted, or when the app's
owner changes.

### 6. Manual review records

Each result version has one current review row and an append-only event log:

- `generation_reviews(result_id PK, app_id, state, notes, reviewer, updated_at, rev)`, where
  `state` is `not_reviewed`, `reviewed` or `needs_changes`, `notes` is up to 4,000
  characters, and `reviewer` and `updated_at` are set by the server.
- `generation_review_events(id, app_id, result_id, actor, from_state, to_state, notes, created_at)`.

A missing row reads as `not_reviewed`. A write must send `If-Match: <rev>`, and a stale
`rev` returns `409`. Review writes touch only these two tables. They never change
integrity, visibility, leases or any public table. Events never contain lease tokens or
preview URLs.

The console (#787) shows two separate labels:

- File check: `Checked file` or `File failed`.
- Language review: `Not reviewed`, `Reviewed` or `Needs changes`, with notes, reviewer and date.

Nothing is labelled "verified correct". Audio previews are fetched with the session and
played from a blob URL.

The console page sits in `workers/admin/web` (`AppDetail.tsx`) and calls the backend
routes with the same console session. `workers/admin/src/auth.ts` is unchanged. Access for
platform admins other than the owner, and for delegated reviewers, is not granted.

### 7. Pilot batch

- App `sayback`: a `text-to-text` set (`opus-mt-en-zh`, `en` → `zh-Hans`) with 10 phrases
  from `en-zh-v1.json`, for example `hello`, `thank-you`, `how-much`, `need-doctor` and
  `no-peanuts`.
- App `dialogue`: a `text-to-audio` set (`kokoro` v1.0, `zf_xiaobei`, `audio/mp4` and
  `audio/wav`) with 10 short Mandarin lines from `graph.json`.

The sets are created through the private API by Serge's console session. Nothing is written
into either app's repository or production data, and Books data is not touched. Each device
runs the jobs it supports. Serge then regenerates one item on another device to compare.

## Acceptance scenarios

1. **Two apps, different models.** Pixel claims and completes `dialogue` TTS jobs with
   Kokoro and `sayback` translation jobs with OPUS-MT from the same Contribute view. The
   browser does the same where the runtime is `supported`. The results appear in the
   console against each app.
2. **Incompatible job refused.** A claim with `setId` for a model not installed, a
   `disabled` or `revoked` model, an unsupported language or voice, or a runtime marked
   `unsupported` for the platform returns `409 incompatible` and creates no lease. A
   legacy Kokoro claim on the public route still returns only public Books-style jobs.
3. **Pause and interruption without burning an allowance.** Each of the following leaves
   the byte budget charged only for bytes actually transferred and the daily upload count
   unchanged: pause during a model download, then resume (the download continues with
   `Range`); kill the app mid-generation (the lease is released or expires, and the job is
   offered again); switch to cellular (Android and iOS stop).
4. **Private output cannot reach a public manifest.** After a successful private result and
   a `reviewed` review, the set's manifest, `…/artifacts/:jobId` and `…/meta` return `404`
   for pilot IDs. Anonymous requests, app-audience sessions, other owners and other apps
   get `401`, `403` or `404` on every private route. The Books manifest is byte-identical
   before and after.
5. **Regeneration.** Regenerating creates version n+1 as `Not reviewed`. Version n keeps its
   review.
6. **Legacy unchanged.** The existing public-route regression tests pass with no edits.
   The shipped Android build (Kokoro claim) and the SDK `contribute()` work against the
   updated backend.

Serge's manual review covers only the tested batch, devices and model versions. It says
nothing about other outputs, other devices or a wider rollout.

## Implementation split

Ordered by dependency. Each issue carries its own acceptance.

| Order | Issue | Scope from this ADR |
|---|---|---|
| 1 | #788 catalogue | `generation-models.json` with the two pilot entries, `GET /v1/generation/models`, the claim-matching function with fixtures, and client-side size/hash verification for the translation files. No device scheduling |
| 1 | #789 typed private backend + SDK | Section 1 tables and routes, section 2 schemas and integrity checks, the `GENERATION_PILOT` flag, retention and pruning, `generation.private` in the SDK, and the isolation and legacy regression tests. Uses fixture catalogue data until #788 lands |
| 2 | #791 review API | Section 6 tables and routes, `If-Match`, and audit and pruning tests. Needs #789 result IDs |
| 2 | #792 contributor controls | Section 4 on Android (extend `ContributeWorker`/`Generation.kt` with a second runner for translation, a durable pause, budgets and thermal checks) and on the web console page (Transformers.js translation, sherpa-onnx WASM TTS attempt). Coordinates the iOS allowlist with #733. Needs #788 and #789 |
| 2 | #733 iOS companion | Kokoro and translation runtimes, `BGProcessingTask`, and the private path allowlist |
| 3 | #787 console | Section 6 UI in `AppDetail.tsx`. Needs #791 |
| 4 | #790 pilot | Section 7 batch on Pixel, iPhone and browser, with acceptance scenarios 1-5 recorded with device, OS and browser versions and model versions |

#783 (leases), #784 (public audio verification), #785 (timings), #732 (attestation) and
Books #66 stay as they are.

## Consequences

- The public pipeline is unchanged, and private data is structurally separate from it.
  The cost is a second, smaller set of lease and result code.
- A model is added only through a reviewed commit. A job cannot widen what a device downloads.
- Native translation and web Mandarin TTS are not proven yet. If either fails in #792 or
  #733, that platform's runtime stays `unsupported` and the pilot records the gap rather
  than substituting another model.
- No language-quality claim follows from the pilot. A wider rollout needs a new decision.
