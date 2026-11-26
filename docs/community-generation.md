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

## API (base `https://api.freeappstore.online/v1`)

Owner: the app owner's session (the app's own or a console session), or a GitHub Actions OIDC token
(audience `https://api.freeappstore.online`) from `refs/heads/main` of the repository the app is
pinned to. A repository is pinned by the app's first keyless deploy.

| Call | Body | Result |
|---|---|---|
| `POST /apps/:appId/generation/sets` | `{ kind: 'tts', model, modelVersion, params, formats, maxBytes, replicas, requireAttestation? }` | `201 { set }` |
| `POST /apps/:appId/generation/sets/:setId/jobs` | `{ jobs: [{ key, input: { text } }] }`, 1-500 | `{ jobs: [{ id, key, status }] }`; `409 { error, keys }` if a key exists with another input |
| `DELETE /apps/:appId/generation/artifacts/:jobId` | | `{ withdrawn: 1 }`; the job reopens |
| `POST /apps/:appId/generation/contributors/:userId/block` | | `{ blocked: true, withdrawn: n }` |

`formats` is a non-empty subset of `audio/mp4`, `audio/ogg`, `audio/wav`; `maxBytes` at most
25,000,000; `replicas` 1-3. Keys are 1-200 characters of `A-Za-z0-9._:/-`; `text` at most 10,000
characters. Re-sending a job with the same key and input is a no-op that returns its status
(`open` or `accepted`).

Contributor: a session delivered to the app (or a console session), or a native companion device
credential (`Bearer ndev_…`). Blocked contributors get `403`.

| Call | Body | Result |
|---|---|---|
| `POST /apps/:appId/generation/claim` | `{ setId?, models: [{ model, modelVersion }] }` | `{ job: { id, setId, key, input, model, modelVersion, params, formats, maxBytes, leaseToken, leaseExpiresAt } }` or `204` |
| `PUT /apps/:appId/generation/jobs/:jobId/result` | multipart `file` + optional `meta` (JSON object, at most 64 KB); header `X-Lease-Token`; optional `X-Attestation` | `202 { submissionId, status }` |
| `GET /apps/:appId/generation/submissions` | | `{ submissions: [{ submissionId, jobId, setId, key, status, reason, bytes, contentType, createdAt, decidedAt }] }`, newest 100 |

- A lease lasts 15 minutes and uploads once. A user holds one open lease: claiming again releases
  the previous one. A user is never given the same job twice (even after a release or rejection).
- A job has at most `replicas` open leases plus pending submissions at a time, each a different user.
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

## Limits

- 200 submissions per user per UTC day across all apps; 5,000 per app per UTC day.
- Leases: 15 minutes, one open per user.
- Jobs: 1-500 per request; text at most 10,000 characters. Sets: `maxBytes` at most 25 MB.

## Storage and lifecycle

Private R2 bucket `fas-generated`, read only through the API. Quarantine `q/<app>/<job>/<submission>`
expires after 7 days (`packages/backend/config/generated-lifecycle.json`, applied by the backend
deploy workflow). Artifacts `a/<app>/<job>/<submission>` are permanent until withdrawn.

The 15-minute reaper (`pruneGenerated`) deletes artifacts, sets, jobs, submissions, blocks and audit
rows of apps that were unpublished or deleted, and rejects submissions still pending after 6 days
(their quarantined bytes are about to expire). Deleting an account removes that user's leases and
submissions and clears the contributor on their accepted artifacts, which stay public.
