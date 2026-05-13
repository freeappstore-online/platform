# App Secret Proxy

Lets a free FAS app safely call third-party APIs that need an API key (OpenWeather, Last.fm, CoinGecko, etc.) without exposing the key to the browser.

The developer registers their key + an allowlist of upstream URLs with the platform. The browser app calls the platform's proxy; the platform Worker decrypts the key, makes the upstream call, returns the response. The key never leaves the Worker.

## Why this exists

Static apps on FAS have no backend. If a developer needs an API key (which most useful third-party APIs require), the only options without this feature are:

- Hardcode the key in the JS bundle → anyone extracts it from `view-source:` and burns the developer's quota.
- Put it in `localStorage` → same problem, plus DevTools-visible to every user.
- Run their own Worker → defeats the "static app on FAS" simplicity.

The proxy makes the secret stay server-side while keeping the developer experience static-app-simple.

**This is not the same as the PAS AI key vault.** The vault stores **end-user** AI keys (OpenAI, Anthropic) and proxies them on the user's behalf — Pro feature. The app-secret proxy stores **developer** API keys for low-cost third-party services — free feature.

| | App secret proxy (FAS) | AI key vault (PAS) |
|---|---|---|
| Whose key | Developer | End user |
| Who pays for upstream | Developer (or third-party free tier) | End user (token billing pass-through, zero markup) |
| Tier | Free | Pro |
| Storage | `app_secrets` table, this Worker | `user_ai_keys` table, PAS Worker |

## Threat model

| Threat | Mitigation |
|---|---|
| Anyone reads developer's API key from JS bundle / localStorage / DevTools | Key never sent to browser. Only the platform Worker has the decryption KEK. |
| Compromised app proxies arbitrary upstream URLs | Strict allowlist per app. Proxy refuses any host not in the app's `app_proxy_allowlist`. |
| AI API abuse via the free proxy (one OpenAI key, $1000 bill) | Hard host blocklist on AI providers (OpenAI, Anthropic, OpenRouter, Google AI). AI usage routes through PAS vault. |
| Single popular app drains developer's third-party quota | Per-app daily request cap (default 10k/day). Returns 429 when exceeded. |
| Database leak exposes all developer keys in plaintext | Envelope encryption — AES-256-GCM. Per-row DEK, KEK in Worker secret. DB compromise alone yields ciphertext only. |
| KEK rotation is expensive | Envelope: rotate KEK = re-wrap each row's DEK (cheap). Doesn't re-encrypt the actual keys. |
| Replay / forged session | All endpoints require a valid HMAC-signed session token. Owner-of-app check on writes. |

## Data model

Three D1 tables. All scoped per-app.

### `app_secrets`

Encrypted developer-supplied API keys.

| Column | Type | Notes |
|---|---|---|
| `app_id` | TEXT NOT NULL | composite PK with `name` |
| `name` | TEXT NOT NULL | e.g. `OPENWEATHER_KEY` (uppercase + underscores by convention) |
| `key_ciphertext` | BLOB NOT NULL | AES-256-GCM ciphertext of the API key |
| `dek_wrapped` | BLOB NOT NULL | DEK encrypted with the master KEK |
| `iv` | BLOB NOT NULL | 12-byte IV used for the key-ciphertext encryption |
| `created_at` | INTEGER NOT NULL | epoch ms |
| `last_used_at` | INTEGER | epoch ms; updated probabilistically (1-in-N) to save D1 writes |

Primary key: `(app_id, name)`.

### `app_proxy_allowlist`

Per-app allowed upstream URL patterns + injection rules.

| Column | Type | Notes |
|---|---|---|
| `app_id` | TEXT NOT NULL | composite PK with `pattern` |
| `pattern` | TEXT NOT NULL | URL prefix; e.g. `https://api.openweathermap.org/data/2.5/` |
| `inject_kind` | TEXT NOT NULL | `query` \| `header` \| `bearer` |
| `inject_name` | TEXT NOT NULL | e.g. `appid` (query), `X-API-Key` (header). Ignored for `bearer`. |
| `secret_name` | TEXT NOT NULL | references `app_secrets.name` |
| `methods` | TEXT NOT NULL | comma-separated allowed HTTP methods, e.g. `GET,POST` |
| `created_at` | INTEGER NOT NULL | |

Primary key: `(app_id, pattern)`.

### `app_proxy_usage`

Per-app daily request counter. Rows expire after the day rolls over (handled at read time; no TTL).

| Column | Type | Notes |
|---|---|---|
| `app_id` | TEXT NOT NULL | composite PK with `day` |
| `day` | TEXT NOT NULL | `YYYY-MM-DD` (UTC) |
| `count` | INTEGER NOT NULL DEFAULT 0 | rolling total for the day |

Primary key: `(app_id, day)`.

Writes are **probabilistic (1-in-10)** — each proxy call increments by 10 with 10% probability. Keeps D1 writes inside free tier even at moderate scale; expected count is unbiased.

## API surface

All endpoints require `Authorization: Bearer <session>`. Write endpoints additionally require the user to be the app's owner (cross-checked against `apps.owner_login`).

### Secret management

```
PUT    /v1/apps/:appId/secrets/:name      { value: string }
DELETE /v1/apps/:appId/secrets/:name
GET    /v1/apps/:appId/secrets             → [{ name, createdAt, lastUsedAt }]   ← never returns value
```

### Allowlist management

```
PUT    /v1/apps/:appId/allowlist           {
  pattern: string,
  injectKind: 'query' | 'header' | 'bearer',
  injectName: string,
  secretName: string,
  methods: string[]
}
DELETE /v1/apps/:appId/allowlist           { pattern: string }
GET    /v1/apps/:appId/allowlist           → [...rules]
```

### The proxy itself

```
ANY /v1/apps/:appId/proxy/<host>/<path...>
```

The Worker:

1. Authenticates the session.
2. Reconstructs the upstream URL: `https://<host>/<path...>?<query>`.
3. Looks up `app_proxy_allowlist` for the app — finds the rule whose `pattern` is a prefix of the URL and whose `methods` includes the request method.
4. If no match → 403 with `{ error: "no allowlist match for <url>" }`.
5. Looks up the secret named in the rule, decrypts it (envelope: KEK from env → unwrap DEK → decrypt key).
6. Injects the key per `inject_kind`/`inject_name`.
7. Forwards the request body as-is (max 100KB; larger → 413).
8. Returns the upstream response (max 100KB body — larger → 502 with `{ error: "upstream response too large" }`).
9. Increments daily counter (probabilistic).

## CLI

```
fas secret set OPENWEATHER_KEY abc123 --app weather
fas secret list --app weather
fas secret rm OPENWEATHER_KEY --app weather

fas proxy allow 'https://api.openweathermap.org/data/2.5/' \
  --app weather \
  --inject 'query:appid' \
  --secret OPENWEATHER_KEY \
  --methods GET

fas proxy list --app weather
fas proxy deny 'https://api.openweathermap.org/data/2.5/' --app weather
```

## SDK

In-app convenience wrapper. Resolves the proxy URL from the user's app id + the registered pattern.

```ts
import { initFas } from '@freeappstore/sdk';
const fas = initFas({ appId: 'weather' });

// equivalent to fetch('https://api.freeappstore.online/v1/apps/weather/proxy/api.openweathermap.org/data/2.5/weather?q=London')
const res = await fas.proxy.fetch('openweathermap.org/data/2.5/weather?q=London');
const data = await res.json();
```

## Free-tier caps

| Resource | Free cap | Pro |
|---|---|---|
| Secrets per app | 5 | 50 |
| Allowlist patterns per app | 5 | 50 |
| Proxy requests per app per day | 10,000 | unlimited |
| Request body size | 100 KB | 1 MB |
| Response body size | 100 KB | 1 MB |
| AI provider hosts (`openai.com`, `anthropic.com`, `openrouter.ai`, `generativelanguage.googleapis.com`) | **blocked at allowlist registration** — must use PAS vault | allowed via PAS vault |

Pro caps land later — for now the implementation enforces the free caps and treats every app as free.

## Cost shape on Cloudflare

Per the per-request analysis in the design discussion:

- **Pre-launch / light usage** (under ~100k proxy req/day): **$0** (within free tier on Workers + D1)
- **Moderate** (200 apps, 500 users × 20 calls = ~2M req/day): **~$15-50/mo** (Workers Paid + small D1 write bill)
- **Single viral app** (50k DAU × 100 calls = 5M req/day): **~$25-100/mo** plus the per-app rate cap activates first

Deliberately avoided: Durable Objects (rate limiting via D1 counters instead) and Workers AI (blocked at the allowlist).

## Cron / housekeeping

None for v1. Old `app_proxy_usage` rows could be GC'd weekly, but at ~365 rows/app/year × 1000 apps = 365k rows = trivial. Defer until storage actually grows.

## Out of scope for v1

- Streaming responses (proxy buffers; SSE/WebSocket upstream not supported).
- Multi-region key replication (D1 is regional; first request from a non-primary region adds latency).
- Per-secret rotation API (delete + recreate works for now).
- Per-user quotas within an app (only per-app daily caps).
- Webhook signature verification helpers (apps that need to receive webhooks signed by upstream services use their own logic in static JS).
