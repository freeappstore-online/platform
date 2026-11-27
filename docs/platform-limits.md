# Platform Limits

Server-enforced quotas for the free tier. These are deliberately conservative -- easier to loosen than to tighten.

FAS stores no application data on the server ([ADR-004](https://github.com/freeappstore-online/platform/blob/main/docs/adr/004-no-server-app-data.md)). App data stays on the user's device (`@freeappstore/sdk/persist`); multi-user or server-backed data belongs on [ProAppStore](https://proappstore.online). The KV, collections, data-room and photo limits below apply only to existing apps that still use those deprecated APIs.

## Auth

| Limit | Value |
|-------|-------|
| Identity providers | GitHub, Google, Apple, Email magic link |
| Session lifetime | 30 days (HMAC-signed bearer token) |

## Per-user KV (`fas.kv`)

Deprecated for app data (ADR-004); existing apps only.

| Limit | Value | On breach |
|-------|-------|-----------|
| Max value size | 64KB | `413` |
| Max bytes per user (per app) | 1MB | `413` |
| Max keys per user (per app) | 100 | `413` |

## Shared counters (`fas.counters`)

| Limit | Value |
|-------|-------|
| Counters per app | 1,000 |
| Increment range | -1,000 to +1,000 per call |
| Counter key | 128 characters (`400`) |

## Collections (`fas.collections`)

Deprecated for app data (ADR-004); existing apps only.

| Limit | Value |
|-------|-------|
| Documents per collection | 10,000 |
| Documents per user per collection | 5,000 (`413`) |
| Distinct collections per app | 200 (`413` when a first document would create one more) |
| Document size | 64KB |
| Shared collections per app (`fas db share`) | 50 (`409`) |

## Realtime rooms (`fas.rooms`)

| Limit | Value | On breach |
|-------|-------|-----------|
| Peers per room | 32 | `503 room full` |
| Sockets per user per room | 4 | `429` |
| Messages per peer per second | 100 | Excess dropped |
| Message size | 4KB | Message dropped |
| Active rooms per app | 64 (a room stops counting after 24h without a join) | `429` for a new room |
| Room id | 1–64 chars of `A-Z a-z 0-9 . _ ~ : @ -` | `400` |
| Idle TTL | 24h | Room state cleared |

Rooms are ephemeral. Messages are not persisted.

## App secret proxy (`fas.proxy`)

| Limit | Value | On breach |
|-------|-------|-----------|
| Secrets per app | 5 | `409` |
| Allowlist rules per app | 5 | `409` |
| Proxy requests per day | 10,000 | `429` |
| Proxy requests per user per day (across all apps) | 5,000 | `429` |
| Request body | 100KB | `413` |
| Response body | 100KB | `502` |

AI provider hosts are blocked from app secrets -- use the user key vault.

## User API key vault (`fas.keys`)

| Limit | Value |
|-------|-------|
| Providers | 7 (OpenAI, Anthropic, Google AI, OpenRouter, Replicate, Stability AI, ElevenLabs) |
| Keys per user | 1 per provider |
| User-key proxy requests | 1,000/day per user across all apps |
| Key size | 500 chars |

## VibeCode sessions (creator console)

| Limit | Value | On breach |
|-------|-------|-----------|
| Sessions per user | 200 | `429` for a new session |
| Stored message data per user | 100 MB (bytes, not characters) | `413` |
| Body of one session write | 2 MB (bytes) | `413` |
| Messages kept per session | last 300 | Older messages trimmed |

## Data rooms

Deprecated for app data (ADR-004); existing apps only.

| Limit | Value |
|-------|-------|
| Rooms owned per user per app | 100 |
| Distinct collections per room | 50 |
| Documents per collection | 10,000 |

## Roles (`fas.roles`)

| Limit | Value | On breach |
|-------|-------|-----------|
| Role assignments per app | 5,000 | `429` |

## Friends (`fas.friends`)

| Limit | Value | On breach |
|-------|-------|-----------|
| Friends per user | 200 | `409` |
| Pending outgoing requests | 50 | `409` |
| Pending request lifetime | 30 days | Request lapses |
| Friend requests | 1 per 3 s per user; 1 min before re-requesting a user who declined | `429` |
| Accept / decline / block / remove | 1 per second per user | `429` |
| Search | 1 per 2 s per user | `429` |

## Logs (`fas.log`)

| Limit | Value | On breach |
|-------|-------|-----------|
| Entries per batch | 100 | Extra entries dropped |
| Entry message / data | 4 KB each | Truncated |
| Rows per user per day (across all apps) | 5,000 | `429` |
| Retention | 7 days | Pruned daily |

## Shared infrastructure

KV and document data (both deprecated for app data, ADR-004) share the platform D1 database. Its capacity is not a dedicated 10 GB allocation for each app. The routes enforce the value, key, document, and collection limits above; they do not implement a separate 100-active-users/day or 1,000-KV-operations/minute allowance. Operational fair-use controls may still apply.

## Email (`fas.email`)

| Limit | Value |
|-------|-------|
| Emails per app per day | 100 |
| Emails per sending user per day | 50 |
| Emails across the whole platform per day | 2,000 |
| Subject | 200 characters |
| HTML or text body | 50,000 characters each |

## Webhooks (`fas.webhooks`)

| Limit | Value |
|-------|-------|
| Webhooks per app | 5 |
| Event types | 4 |
| Signing | HMAC-SHA256 |

## Push subscriptions (`fas.push`)

| Limit | Value | Status code on breach |
|---|---|---|
| Subscriptions (devices) per user per app | 10 | `413` |
| Request body (`POST` / `DELETE /v1/apps/:appId/push/subscriptions`) | 4 KB | `413` |
| Endpoint URL length | 2,048 chars | `400` |
| Reminder schedules per user per app (`PUT /v1/apps/:appId/push/schedules/:reminderId`) | 20 | `413` |
| Reminder needs a registered device for the user and app | required | `409` |
| Due reminders delivered per user per app per cron tick | 5 (the rest wait for later ticks) | deferred |
| One-shot reminder lead time | up to 1 year | `400` |
| Repeat interval (`every`) | 1 to 365 days | `400` |

Reminders are delivered by the backend's 15-minute cron, so they arrive up to ~15 minutes after their time. A reminder due inside the user's quiet hours is held until the window ends; one more than 6 hours overdue is skipped rather than sent late. Per device, `404`/`410` from the push service deletes the subscription, and 5 consecutive failures drop it. An occurrence that reached no device because of transient errors is retried up to 3 times, 15 minutes apart.

Scoped to `(appId, userId)` like KV. One row per browser registration, keyed by its endpoint: re-subscribing the same device updates it (and doesn't count again), and an endpoint re-registered by another user or app moves to them. Endpoints must be `https` on a known push service (FCM, Mozilla, WNS, Apple); `keys.p256dh` must be a 65-byte P-256 point and `keys.auth` 16 bytes (both base64url). `GET /v1/push/vapid-public-key` returns `503` until the platform VAPID key is configured.

## Client bundle (`fas check` bundle-size)

| Limit | Value | On breach |
|-------|-------|-----------|
| Initial-load JS (entry chunk + static imports) | 300 KB gzipped per file | `fas check` **fail** |
| Lazy asset (dynamic chunk, worker, `.wasm`, model/data file) | 25 MB uncompressed per file | `fas check` **fail** |

Initial load is what the browser downloads from the HTML parse: the entry `<script>` plus its static
imports (`<link rel="modulepreload">` and ESM `import`). `import()`, `new Worker()`, and
`new URL(..., import.meta.url)` assets are lazy. Source of truth:
`packages/compliance/src/lib/bundle-limits.ts`.

## What FAS does NOT support

These features are not exposed by the FreeAppStore SDK. For a separate paid platform, see [ProAppStore](https://proappstore.online); its current plans and limits are defined there:

- Server-side app data: documents, records, files and multi-user collaboration ([ADR-004](https://github.com/freeappstore-online/platform/blob/main/docs/adr/004-no-server-app-data.md)). Keep app data on the device
- General-purpose file uploads (the small temporary photo uploads in [Photo uploads](photo-uploads.md) are deprecated for app data)
- Server-side AI (Workers AI)
- Arbitrary server-side cron / scheduled tasks (scheduled user push reminders are supported above)
- Custom domains
- Monetization (Stripe + creator payouts). FAS apps take no payments: the host blocks the Payment Request API and `fas check` rejects payment code. Apps show no ads either: `fas check` rejects ad network SDKs. See [Browser Capabilities](capabilities.md#no-payments).
- Server-side compute (per-app Worker + D1)

## Source of truth

Implementation and configuration define the limits:

- `packages/backend/src/lib/quota.ts`: KV and push caps
- `packages/backend/src/routes/db.ts`: collections
- `packages/backend/src/routes/counters.ts`: counters
- `packages/backend/src/routes/email.ts`: email
- `packages/backend/src/routes/webhooks.ts`: supported events and webhook cap
- `packages/backend/src/routes/secrets.ts`: app-secret and user-key proxy
- `packages/backend/src/routes/keys.ts`: key vault
- `packages/backend/src/routes/roles.ts`: roles
- `packages/backend/src/routes/friends.ts`: friends
- `packages/backend/src/routes/logs.ts` and the daily prune in `index.ts`: logs
- `packages/backend/src/routes/data-rooms.ts`: data rooms
- `packages/backend/src/routes/generation.ts`: community generation
- `packages/backend/src/routes/agent-sessions.ts`: VibeCode sessions
- `packages/backend/src/lib/session.ts`: session lifetime
- `packages/backend/src/do/room.ts` and `routes/rooms.ts`: realtime limits
- `packages/compliance/src/lib/bundle-limits.ts`: initial JS and lazy-asset caps

When you change a limit, update the implementation, this page and the relevant public capability pages together, and check whether the change also needs an SDK release.

Browser APIs are a separate concern: see [Browser Capabilities](capabilities.md). A documented API can still require configured platform credentials, user sign-in, browser support, and permission.

## Temporary photo uploads

Deprecated for app data (ADR-004); existing apps only. See [Photo uploads](photo-uploads.md): 640 px maximum edge, 200,000 bytes, JPEG/WebP only, 90-day retention, private by default.

## Community generation

See [Community generation](community-generation.md): 5,000 submissions per app per UTC day and no per-user cap, 15-minute leases (one open per runner, at most 4 per user), 1-500 jobs per request, text at most 100,000 characters, 1-50 attempt records per request and 1,000 per user per UTC day, `maxBytes` at most 25 MB, meta at most 64 KB, quarantine expires after 7 days.
