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

## Collections (`fas.db`)

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
| Active rooms per app | 64 | LRU eviction |
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
| Key size | 500 chars |

## Per-app caps

| Limit | Value |
|-------|-------|
| Registered users | Unlimited (fair use) |
| Storage across all users | 10GB (D1 ceiling) |

## Email (`fas.email`)

| Limit | Value |
|-------|-------|
| Emails per app per day | 100 |

## Webhooks (`fas.webhooks`)

| Limit | Value |
|-------|-------|
| Webhooks per app | 5 |
| Event types | 8 |
| Signing | HMAC-SHA256 |

## What FAS does NOT support

These features require [ProAppStore](https://proappstore.online):

- File uploads / R2 storage
- Server-side AI (Workers AI)
- Cron / scheduled tasks
- Custom domains
- Monetization (Stripe + creator payouts)
- Server-side compute (per-app Worker + D1)
