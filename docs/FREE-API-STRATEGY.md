# Free API Integration Strategy

How free apps on FreeAppStore integrate with third-party APIs without costing developers or users money, while keeping users in control of their own data and API keys.

## The problem

Free apps need external APIs (AI, weather, maps, translation, etc.) but:
- Developers can't pay for API calls at scale (the app is free)
- The platform can't subsidize every app's API usage (free tier)
- Users won't sign up for 10 different API providers just to use an app

## Three integration models

### Model 1: No-key APIs (platform pre-configured)

Many useful APIs are genuinely free and require no API key at all. Apps should prefer these first.

| Category | Free API | Rate limit | Notes |
|---|---|---|---|
| Weather | Open-Meteo | 10k/day | No key, no signup |
| Geocoding | Nominatim | 1/sec | No key, requires User-Agent |
| IP geolocation | ip-api.com | 45/min | No key, HTTP only |
| Exchange rates | ExchangeRate-API | 1.5k/mo | No key (open access) |
| Random data | randomuser.me | Unlimited | No key |
| Placeholder images | picsum.photos | Unlimited | No key |
| Public datasets | data.gov, WHO, World Bank | Varies | No key |
| Lorem text | loripsum.net | Unlimited | No key |
| QR codes | goqr.me | Unlimited | No key |
| Country data | restcountries.com | Unlimited | No key |
| Hacker News | hn.algolia.com | Unlimited | No key |
| Wikipedia | en.wikipedia.org/api | Rate-limited | No key, requires User-Agent |
| Open Library | openlibrary.org/api | Rate-limited | No key |
| Dictionary | dictionaryapi.dev | Unlimited | No key |

**For AI specifically:**
- No free-no-key AI API exists at quality sufficient for production use
- Ollama/local models require user hardware
- Workers AI is platform-managed (PAS only, Tier 1)

**Platform action:** Maintain a curated list of no-key APIs in SKILLS.md. Apps calling these don't need the proxy at all -- direct `fetch()` from the browser works. The proxy adds zero value when there's no secret to inject.

### Model 2: Developer-subsidized (app-secret proxy)

Developer registers their own API key. Platform encrypts it, injects it server-side. All users of the app share the same key.

**When to use:**
- Low-cost APIs where the developer is willing to pay (e.g., OpenWeather free tier: 1k calls/day)
- APIs where the developer's key has a free tier sufficient for the app's traffic
- Internal/private APIs the developer controls

**Caps (enforced by platform):**
- 5 secrets per app
- 5 allowlist rules per app
- 10,000 proxy requests/day per app
- AI provider hosts blocked (use Model 3 instead)

**Developer experience:**
1. `fas secret set WEATHER_KEY sk-...` (or use Console UI)
2. `fas allowlist add https://api.openweathermap.org/ --inject query:appid --secret WEATHER_KEY`
3. App code: `fas.proxy.fetch('api.openweathermap.org/data/2.5/weather?q=London')`

### Model 3: User-funded (user key vault)

User stores their own API key on the platform. Each user pays their own provider bill. Developer pays nothing. Platform pays nothing.

**When to use:**
- AI providers (OpenAI, Anthropic, Google AI, etc.) -- the only viable model at scale
- Any API where per-user billing is appropriate
- APIs with generous free tiers per account (user gets their own free tier)

**User experience:**
1. User opens app, app detects no key: shows `<KeyPrompt provider="openai" />`
2. User clicks "Configure OpenAI key" -- redirected to platform key page
3. Platform page links to provider's API key page ("Get API key" link)
4. User pastes key, clicks Save (encrypted AES-256-GCM, stored on platform)
5. User is redirected back to app -- everything works

**Developer experience:**
1. App code: `fas.proxy.fetch('api.openai.com/v1/chat/completions', { method: 'POST', body: ... })`
2. If user has no key, proxy returns `{ error: "no_key", provider: "openai", manage_url: "..." }`
3. App catches this and renders `<KeyPrompt app={fas} provider="openai" providerName="OpenAI" />`
4. Zero key management code in the app

**Supported providers (platform pre-configured):**
OpenAI, Anthropic, Google AI, OpenRouter, Replicate, Stability AI, ElevenLabs, Stripe

**Adding new providers:** Platform admin inserts a row into `key_providers` table. No code change needed.

## Decision tree for developers

```
Does the API require a key?
├── No  → Call it directly from the browser. No proxy needed.
│         (Open-Meteo, Nominatim, restcountries, etc.)
│
├── Yes, and the free tier covers my expected traffic
│   └── Use Model 2 (app-secret proxy)
│       Store your key via Console or CLI. Users never see it.
│       Cap: 10k requests/day shared across all users.
│
├── Yes, and each user should pay their own usage
│   └── Use Model 3 (user key vault)
│       Show <KeyPrompt>, user adds their own key.
│       No cap on per-user proxy requests.
│
└── Yes, but it's expensive and I can't subsidize it
    └── Use Model 3 (user key vault)
        This is the only sustainable model for AI APIs on a free platform.
```

## Making Model 3 less painful

The biggest friction in user-funded APIs is getting the user to sign up for a provider and paste a key. Strategies to reduce this:

### 1. One-time setup, works across all apps
Keys are stored at the platform level, not per-app. A user who configures their OpenAI key for one app has it available in every app on the platform. No re-entry.

### 2. Provider signup links
The key management page links directly to each provider's API key page. One click to get there, one paste to set up.

### 3. Graceful degradation
Apps should work (with reduced functionality) without API keys. The AI-powered feature is an enhancement, not a gate. Show the `<KeyPrompt>` only when the user tries to use the AI feature, not on app load.

### 4. Provider free tiers
Most AI providers offer free tiers:
- OpenAI: $5 credit on signup
- Anthropic: free tier for Claude Haiku
- Google AI: Gemini free tier (generous)
- OpenRouter: aggregates free models

Apps should default to the cheapest model that works. A todo app's AI summarizer doesn't need GPT-4o -- GPT-4o-mini at 1/30th the cost is fine.

### 5. Default to what users already have
Most users already have an OpenAI account. Don't ask them to sign up for a new provider. Pick the one they most likely already have:

- **OpenAI** -- most widely held, best default for most AI apps
- **Google AI (Gemini)** -- most generous free tier, good for cost-sensitive apps
- **Anthropic** -- strong for coding/reasoning apps
- **OpenRouter** -- power-user option, one key for 100+ models. Good for apps that want model flexibility, but don't make it the default since most users don't have an account

**Rule of thumb:** default to OpenAI unless you have a specific reason not to.

## What the platform provides (summary)

| Layer | What | Who pays | Friction |
|---|---|---|---|
| No-key APIs | Curated list in docs | Nobody | Zero |
| App-secret proxy | Encrypted dev keys, allowlist, injection | Developer | Low (one-time CLI/Console setup) |
| User key vault | Encrypted user keys, proxy fallback, KeyPrompt UI | User (their own provider account) | Medium (one-time per provider, works across all apps) |

## What we explicitly don't do

- **No platform-subsidized AI.** Workers AI is PAS-only. Free apps use user keys.
- **No API key sharing between users.** Each user's key is theirs alone.
- **No per-app key entry UI.** Keys are managed on the platform page, not in app UI.
- **No key export.** Users can delete keys but can't view plaintext after storage.
- **No free proxy for AI without a key.** If the user hasn't configured a key, the proxy returns `no_key`. No freemium AI subsidized by the platform.

## Implementation status

| Component | Status |
|---|---|
| No-key API list in docs | Needs addition to SKILLS.md |
| App-secret proxy (Model 2) | **Live** |
| Console UI for secrets | **Live** |
| User key vault (Model 3) | **Live** |
| Proxy user-key fallback | **Live** |
| `<KeyPrompt>` SDK component | **Live** |
| "API Keys" in ProfileMenu | **Live** |
| Platform key management page | **Live** |
| OpenRouter recommendation in docs | Needs addition |
