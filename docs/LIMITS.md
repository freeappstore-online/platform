# v0 Platform Limits

Authoritative list of limits enforced by `@freeappstore/backend`. The SDK clients honor these too, but the server is the source of truth — these are the numbers that, if exceeded, return `413` or `429`.

The intent is to keep the entire platform inside Cloudflare's free / cheap tiers and prevent any single app from blowing it up for everyone else. Numbers are deliberately conservative for v0 and easier to loosen than to tighten.

## Auth

| Limit | Value | Notes |
|---|---|---|
| Identity providers | GitHub, Google, Apple, Email magic link | 4 providers via `fas.auth.signIn(provider)` |
| Session lifetime | 30 days | HMAC-signed bearer token; rotate `SESSION_SIGNING_KEY` to revoke all sessions. |

## Per-user KV (`fas.kv`)

| Limit | Value | Status code on breach |
|---|---|---|
| Max bytes per value | 64 KB | `413` |
| Max bytes per user (all keys, this app) | 1 MB | `413` |
| Max keys per user (this app) | 100 | `413` |

Keys are arbitrary UTF-8 strings; values are stored as opaque JSON blobs. Scoped to `(appId, userId)` — apps cannot read each other's data, and users cannot read each other's data.

## Realtime rooms (`fas.rooms`)

| Limit | Value | Behavior on breach |
|---|---|---|
| Concurrent peers per room | 32 | New connections rejected (`503 room full`) |
| Messages per peer per second | 100 | Excess messages dropped, peer warned (`{"kind":"error","error":"rate_limited"}`) |
| Bytes per message | 4 KB | Message dropped, peer warned (`message_too_large`) |
| Active rooms per app | 64 | `429` for a new room; existing rooms keep working. A room stops counting after 24h without a join |
| Room id | 1–64 chars of `A-Z a-z 0-9 . _ ~ : @ -` | `400` |
| Idle TTL | 24 h | Room state cleared if no activity for 24h |

Rooms are **ephemeral**. Messages are not persisted. Use `fas.kv` for anything that needs to survive a refresh.

## Per-app caps (cumulative)

| Limit | Value |
|---|---|
| Total registered users | unlimited (subject to fair use) |
| Storage across all users | 10 GB / app (D1 ceiling) |

Hard breaches at this layer page the platform admin and may pause the offending app's writes until investigated.

## App-secret proxy (`fas.proxy`)

| Limit | Value | Behavior on breach |
|---|---|---|
| Secrets per app | 5 | `409` on PUT |
| Allowlist rules per app | 5 | `409` on PUT |
| Proxy requests per day (app secrets) | 10,000 | `429` |
| Request body size | 100 KB | `413` |
| Response body size | 100 KB | `502` |
| User-key proxy requests | Unlimited | — |

AI provider hosts (openai.com, anthropic.com, etc.) are blocked from app-level secrets. Apps that need AI must use the user key vault.

## User API key vault (`fas.keys`)

| Limit | Value |
|---|---|
| Providers | 8 seeded (OpenAI, Anthropic, Google AI, OpenRouter, Replicate, Stability AI, ElevenLabs, Stripe) |
| Keys per user | 1 per provider |
| Key size | 500 chars max |

## Collections (`fas.collections`)

| Limit | Value |
|---|---|
| Documents per collection | 10,000 |
| Document size | 64 KB |

## Shared counters (`fas.counters`)

| Limit | Value |
|---|---|
| Counters per app | 1,000 |
| Increment range | -1,000 to +1,000 per call |

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

## What FAS does NOT support (use ProAppStore)

- File uploads / R2 storage — PAS gives each app its own bucket
- Server-side AI — PAS includes Workers AI
- Cron / scheduled tasks — PAS has Cron Workers. (Scheduled push reminders for your users *are* in FAS: see `fas.push.schedule` above.)
- Custom domains — PAS supports your-domain.com
- Monetization — PAS has Stripe + creator payouts
- Server-side compute — PAS gives each app a Worker + D1

See [proappstore.online](https://proappstore.online) for the Pro tier.

## Changing limits

Constants live next to the code that enforces them:

- KV: `packages/backend/src/routes/kv.ts`
- Push subscriptions: `PUSH_LIMITS` in `packages/backend/src/lib/quota.ts`
- Rooms: `packages/backend/src/do/room.ts`
- Session TTL: `packages/backend/src/lib/session.ts`

A change to any of these is a public-API behavior change and should bump the SDK version.
