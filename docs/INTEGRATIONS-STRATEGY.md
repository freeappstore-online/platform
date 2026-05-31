# FAS Integrations Strategy

How FreeAppStore approaches third-party API integrations. Three tiers, one principle: app code never touches a secret.

Mirrors the PAS strategy (`proappstore-online/platform/docs/INTEGRATIONS-STRATEGY.md`) adapted for the free tier.

## Principle

Every third-party API call flows through the platform Worker. The browser SDK never touches a secret. This gives us rate limiting, audit logging, credential rotation, and abuse prevention for free.

## Three Tiers

### Tier 1: Platform-managed

Platform owns the credentials. One account serves all apps. Devs call an SDK method, platform pays and rate-limits.

| Integration | Status | FAS SDK method | Backed by | Notes |
|---|---|---|---|---|
| Auth (GitHub OAuth) | **Live** | `fas.auth.signIn()` | GitHub OAuth | Platform-managed OAuth app |
| Transactional email | **Live** | `fas.email.send()` | Resend | 100/day per app, magic link auth + app-triggered |

FAS is free-tier. Heavy platform-managed services (AI, maps, SMS, push) live on PAS only. FAS apps that need AI use Tier 2 (user's own key).

### Tier 2: Key vault + proxy

Dev or user brings their own API key. Platform stores it encrypted (AES-256-GCM envelope encryption), injects it server-side. The browser never sees the key.

| Integration | How | Status |
|---|---|---|
| **App-developer secrets** | Dev registers key via `fas secret set NAME value` + allowlist rule | **Live** |
| **User API keys** (OpenAI, Anthropic, etc.) | User adds key at `/v1/keys`, app calls `fas.proxy.fetch()` | **Live** |
| Any REST API | `fas.proxy.fetch(url)` | **Live** |

**Two sub-tiers within Tier 2:**

1. **App secrets** (developer-managed): Developer stores a key for their app. All users of the app share the same key. Capped at 5 secrets, 5 allowlist rules, 10k requests/day per app. AI provider hosts are blocked at this level (use user keys instead).

2. **User keys** (user-managed): Each user stores their own key for a provider (e.g., OpenAI). The proxy falls back to user keys when no app-level allowlist matches. No daily cap on user-key proxied requests. Supported providers: OpenAI, Anthropic, Google AI, OpenRouter, Replicate, Stability AI, ElevenLabs, Stripe.

### Tier 3: Webhooks (events out)

Platform fires HTTP POST on events. Devs configure webhook URLs per app. Zapier, Make, n8n, and any HTTP endpoint work natively.

**Proposed FAS events:**

| Event | Payload | Use case |
|---|---|---|
| `user.first_visit` | `{ userId, appId, login }` | Welcome flows |
| `user.deleted` | `{ userId, appId }` | Data cleanup |
| `kv.changed` | `{ userId, appId, key, action }` | Sync to external DB |
| `collection.created` | `{ appId, collection, docId }` | Notifications |
| `collection.deleted` | `{ appId, collection, docId }` | Cleanup |
| `counter.threshold` | `{ appId, counter, value, threshold }` | Alerts |
| `role.assigned` | `{ userId, appId, role }` | Permission sync |
| `role.revoked` | `{ userId, appId, role }` | Permission sync |

**Implementation plan (when prioritized):**
- D1 table: `app_webhooks (app_id, event, url, secret, active, created_at)`
- Backend: `/v1/apps/:appId/webhooks` CRUD endpoints
- Dispatcher: fire-and-forget via `waitUntil()`, retry on 5xx (max 3), dead-letter log
- HMAC-SHA256 signature in `X-FAS-Signature` header for verification
- SDK: `fas.webhooks.list()`, `fas.webhooks.create(event, url)`, `fas.webhooks.delete(id)`
- Console UI: webhook management per app
- Free tier cap: 5 webhook subscriptions per app, 1000 events/day

## What we don't build

- **Zapier/Make connectors.** Webhooks are the standard. Every automation platform accepts them.
- **Per-provider AI SDK wrappers.** No `fas.openai.*`. The proxy + vault pattern handles any provider.
- **Integration marketplace.** The proxy handles unlimited third-party APIs without provider-specific code.

## What FAS has that PAS doesn't

- **App-secret proxy with allowlist** (PAS uses direct per-app D1 instead)
- **User key vault with auto-fallback in proxy** (PAS key vault is separate from proxy)
- **Public config guidance** (VITE_* via GitHub Variables, documented in SKILLS.md)

## What PAS has that FAS doesn't (yet)

- **Platform AI** (Workers AI) -- FAS apps use user keys through the proxy
- **Maps, push, SMS** -- PAS Tier 1 services
- **Full-text search** -- D1 FTS5 (planned for PAS)

## Implementation priority for FAS

1. ~~**Transactional email**~~ — **Shipped.** `fas.email.send()` live, 100/day per app.
2. ~~**Outbound webhooks**~~ — **Shipped.** `fas.webhooks` CRUD + HMAC-SHA256, 5 per app, 8 events.
3. **Full-text search** -- D1 FTS5 on the shared database. Low effort, useful for apps with collections.
