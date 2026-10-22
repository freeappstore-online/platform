# Platform Limits

Server-enforced quotas for the free tier. These are deliberately conservative -- easier to loosen than to tighten.

## Auth

| Limit | Value |
|-------|-------|
| Identity providers | GitHub, Google, Apple, Email magic link |
| Session lifetime | 30 days (HMAC-signed bearer token) |

## Per-user KV (`fas.kv`)

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

## Collections (`fas.collections`)

| Limit | Value |
|-------|-------|
| Documents per collection | 10,000 |
| Document size | 64KB |

## Realtime rooms (`fas.rooms`)

| Limit | Value | On breach |
|-------|-------|-----------|
| Peers per room | 32 | `503 room full` |
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
| Request body | 100KB | `413` |
| Response body | 100KB | `502` |

AI provider hosts are blocked from app secrets -- use the user key vault.

## User API key vault (`fas.keys`)

| Limit | Value |
|-------|-------|
| Providers | 8 (OpenAI, Anthropic, Google AI, OpenRouter, Replicate, Stability AI, ElevenLabs, Stripe) |
| Keys per user | 1 per provider |
| User-key proxy requests | 1,000/day per user across all apps |
| Key size | 500 chars |

## Shared infrastructure

KV and document data share the platform D1 database. Its capacity is not a dedicated 10 GB allocation for each app. The routes enforce the value, key, document, and collection limits above; they do not implement a separate 100-active-users/day or 1,000-KV-operations/minute allowance. Operational fair-use controls may still apply.

## Email (`fas.email`)

| Limit | Value |
|-------|-------|
| Emails per app per day | 100 |
| Emails per sending user per day | 50 |
| Subject | 200 characters |
| HTML or text body | 50,000 characters each |

## Webhooks (`fas.webhooks`)

| Limit | Value |
|-------|-------|
| Webhooks per app | 5 |
| Event types | 12 |
| Signing | HMAC-SHA256 |

## Push subscriptions (`fas.push`)

| Limit | Value | Status code on breach |
|---|---|---|
| Subscriptions (devices) per user per app | 10 | `413` |
| Request body (`POST` / `DELETE /v1/apps/:appId/push/subscriptions`) | 4 KB | `413` |
| Endpoint URL length | 2,048 chars | `400` |
| Reminder schedules per user per app (`PUT /v1/apps/:appId/push/schedules/:reminderId`) | 20 | `413` |
| One-shot reminder lead time | up to 1 year | `400` |
| Repeat interval (`every`) | 1 to 365 days | `400` |

Reminders are delivered by the backend's 15-minute cron, so they arrive up to ~15 minutes after their time. A reminder due inside the user's quiet hours is held until the window ends; one more than 6 hours overdue is skipped rather than sent late. Per device, `404`/`410` from the push service deletes the subscription, and 5 consecutive failures drop it. An occurrence that reached no device because of transient errors is retried up to 3 times, 15 minutes apart.

Scoped to `(appId, userId)` like KV. One row per browser registration, keyed by its endpoint: re-subscribing the same device updates it (and doesn't count again), and an endpoint re-registered by another user or app moves to them. Endpoints must be `https` on a known push service (FCM, Mozilla, WNS, Apple); `keys.p256dh` must be a 65-byte P-256 point and `keys.auth` 16 bytes (both base64url). `GET /v1/push/vapid-public-key` returns `503` until the platform VAPID key is configured.

## What FAS does NOT support

These features are not exposed by the FreeAppStore SDK. For a separate paid platform, see [ProAppStore](https://proappstore.online); its current plans and limits are defined there:

- File uploads / R2 storage
- Server-side AI (Workers AI)
- Arbitrary server-side cron / scheduled tasks (scheduled user push reminders are supported above)
- Custom domains
- Monetization (Stripe + creator payouts). FAS apps take no payments: the host blocks the Payment Request API and `fas check` rejects payment code. See [Browser Capabilities](capabilities.md#no-payments).
- Server-side compute (per-app Worker + D1)

## Source of truth

Implementation and configuration define the limits:

- `packages/backend/src/lib/quota.ts`: KV and push caps
- `packages/backend/src/routes/db.ts`: collections
- `packages/backend/src/routes/counters.ts`: counters
- `packages/backend/src/routes/email.ts`: email
- `packages/backend/src/routes/webhooks.ts`: supported events and webhook cap
- `packages/backend/src/routes/secrets.ts`: app-secret proxy
- `packages/backend/src/lib/session.ts`: session lifetime
- `packages/backend/src/do/room.ts` and `routes/rooms.ts`: realtime limits

Browser APIs are a separate concern: see [Browser Capabilities](capabilities.md). A documented API can still require configured platform credentials, user sign-in, browser support, and permission.
