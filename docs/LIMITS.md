# v0 Platform Limits

Authoritative list of limits enforced by `@freeappstore/backend`. The SDK clients honor these too, but the server is the source of truth — these are the numbers that, if exceeded, return `413` or `429`.

The intent is to keep the entire platform inside Cloudflare's free / cheap tiers and prevent any single app from blowing it up for everyone else. Numbers are deliberately conservative for v0 and easier to loosen than to tighten.

## Auth

| Limit | Value | Notes |
|---|---|---|
| Identity providers | GitHub OAuth only | More providers come in v0.1+ once we know what creators ask for. |
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
| Active rooms per app | 64 | LRU eviction; oldest idle room is evicted |
| Idle TTL | 24 h | Room state cleared if no activity for 24h |

Rooms are **ephemeral**. Messages are not persisted. Use `fas.kv` for anything that needs to survive a refresh.

## Per-app caps (cumulative)

| Limit | Value |
|---|---|
| Total registered users | unlimited (subject to fair use) |
| Storage across all users | 10 GB / app (D1 ceiling) |

Hard breaches at this layer page the platform admin and may pause the offending app's writes until investigated.

## What's NOT limited yet (because it doesn't exist yet)

- File uploads / R2 — module not in v0.
- Push notifications — module not in v0.
- Outbound HTTP / AI proxy — module not in v0.
- Per-app egress — relies on Cloudflare's account-wide limits for now.

## Changing limits

Constants live next to the code that enforces them:

- KV: `packages/backend/src/routes/kv.ts`
- Rooms: `packages/backend/src/do/room.ts`
- Session TTL: `packages/backend/src/lib/session.ts`

A change to any of these is a public-API behavior change and should bump the SDK version.
