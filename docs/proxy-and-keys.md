# Proxy & Keys

Two systems for calling third-party APIs without exposing secrets in the browser.

## App secret proxy (`fas.proxy`)

For APIs that need a **developer-owned** API key (weather, geocoding, etc.). The developer stores the key on the platform; the proxy injects it server-side on each request.

### How it works

1. Developer stores a secret: `fas secret set OPENWEATHER_KEY abc123`
2. Developer creates an allowlist rule: `fas proxy allow "https://api.openweathermap.org/" --secret OPENWEATHER_KEY --inject "query:appid"`
3. App calls the proxy: `fas.proxy.fetch('api.openweathermap.org/data/2.5/weather?q=London')`
4. Platform Worker decrypts the key, injects it into the request, forwards to the upstream API, returns the response

The key never reaches the browser.

### Injection modes

| Mode | Flag | Example |
|------|------|---------|
| Query parameter | `--inject "query:appid"` | Appends `?appid=<key>` |
| Header | `--inject "header:X-API-Key"` | Adds `X-API-Key: <key>` header |
| Bearer token | `--inject bearer` | Adds `Authorization: Bearer <key>` |
| OAuth2 client credentials | `--inject oauth2_cc` | Exchanges credentials for access token |

### Security

- Keys encrypted at rest with AES-256-GCM (envelope encryption)
- Strict per-app URL allowlist -- proxy refuses unregistered hosts
- AI provider hosts (openai.com, anthropic.com, etc.) are **blocked** -- use the user key vault instead
- Per-app daily request cap (10,000/day)

### Limits

| Resource | Limit |
|----------|-------|
| Secrets per app | 5 |
| Allowlist rules per app | 5 |
| Proxy requests per day | 10,000 |
| Request body | 100KB |
| Response body | 100KB |

## User API key vault (`fas.keys`)

For APIs that need an **end-user-owned** API key (OpenAI, Anthropic, etc.). Users store their own keys on the platform once; apps request access without seeing the plaintext.

### How it works

1. User configures their API key on the platform key management page
2. App checks if the user has a key: `await fas.keys.has('openai')`
3. If not, prompt them: `<KeyPrompt app={fas} provider="openai" providerName="OpenAI" />`
4. App calls APIs through the platform proxy, which injects the user's key

### SDK

```ts
const hasKey = await fas.keys.has('openai');
fas.keys.manage('openai');            // redirect to key management
const keys = await fas.keys.status(); // all configured providers
```

### Supported providers

OpenAI, Anthropic, Google AI, OpenRouter, Replicate, Stability AI, ElevenLabs, Stripe.

### Security

- Keys encrypted with AES-256-GCM
- Per-user, per-provider isolation
- Apps never see plaintext keys
- Users can revoke keys at any time

## Free APIs (no proxy needed)

Many useful APIs require no key at all. Prefer these first:

| Category | Options |
|----------|---------|
| Maps | Leaflet, OpenStreetMap |
| Charts | Recharts |
| Weather | Open-Meteo |
| Geocoding | Nominatim |
| Routing | OSRM |
| Countries | REST Countries |
| Rich text | Tiptap |
| Icons | Lucide React |
| Animation | Framer Motion |
| Drag & drop | dnd-kit |
| QR codes | qrcode.react |
| Dates | date-fns |
| Markdown | react-markdown |
| Forms | React Hook Form |
| State | Zustand |
