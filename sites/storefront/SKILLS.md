# FreeAppStore / FreeGameStore — AI Agent Guide

Point your Claude Code, Codex, or any AI agent to this file for platform-aware development.

**Add to your CLAUDE.md or agent config:**
```
See https://freeappstore.online/skills.md for platform skills.
```

---

## Per-repo CLAUDE.md convention

Every app/game/template repo on the platform ships its own `CLAUDE.md`. **Keep it minimal — only what's unique to that repo.** Anything in this SKILLS.md (tech stack, brand, deploy flow, mobile-first rules, publish flow, paths) does *not* belong in a per-repo CLAUDE.md, because copies drift out of sync with the platform and produce subtly-wrong instructions for AI agents.

Use this slim template:

````markdown
# <name>

<one-line description of what this app/game does>

- Subdomain: `<name>.freeappstore.online`   <!-- or .freegamestore.online -->
- Dev:    `pnpm install && pnpm dev`
- Build:  `pnpm build`
- Deploy: `git push origin main` (auto-deploys to R2 via GitHub Actions)

Free, MIT-licensed, no tracking. For platform conventions, read
https://freeappstore.online/skills.md
before writing or changing anything.
````

If your repo has setup steps, architecture notes, or rules that *don't* apply platform-wide (a specific OAuth flow, an unusual toolchain, an architecture diagram), add them as additional sections **below** the slim block. Those are genuinely repo-local and belong there.

What does *not* belong in a per-repo CLAUDE.md:

- Tech stack list (it's here, in SKILLS.md, and changes platform-wide)
- Brand guidelines (here)
- Deploy mechanism details beyond "push to main" (here)
- Mobile-first / viewport rules (here, with the auditor section)
- Storefront paths or registry locations (here)

Drift is the failure mode. If we ever update the platform conventions, only this file should need editing — never 80 per-repo copies.

---

## Publishing platform packages — never manually

**All npm publishes are automated via GitHub Actions** (`.github/workflows/publish.yml` in `freeappstore-online/platform`). Manual `npm publish` is not part of any release flow on this platform.

Affected packages: `@freeappstore/{sdk,cli,compliance,quality}`, `@freegamestore/{cli,games}`. The same workflow handles all of them.

**Release flow** (the only flow):

```bash
cd packages/<name>          # e.g. packages/sdk
npm version patch           # or minor / major. bumps version + creates a commit + tag
git push --follow-tags      # CI sees local version != npm version → publishes with provenance
```

That's it. No `npm publish`. No `npm login`. No npm token request. No local build-and-push.

**Why this matters:** the workflow uses `pnpm publish --provenance`, which attaches a signed attestation linking the tarball to a specific GitHub Actions run. Manual publishes bypass the attestation, the audit trail, and the workspace-dependency rewriting that `pnpm publish` does (without it, consumers get `EUNSUPPORTEDPROTOCOL workspace:` on install). They can also race against CI and publish from a dirty / unbuilt local tree.

**Same pattern across the family:**

- App / game repos auto-deploy to R2 via GitHub Actions on push to `main` — never `wrangler pages deploy` manually.
- The backend Worker (`packages/backend`) is the one exception: it's not on a push-trigger workflow, so `wrangler deploy` is the right command. Check `.github/workflows/` first to confirm before running anything that ends in "deploy" or "publish".

**As an AI agent:** if a user asks "how do I publish the SDK", the answer is the three commands in the Release flow box above. Do not suggest `npm publish`. Do not ask for an npm token.

---

## Creator Program

People join as creators to build apps/games. The flow:

1. Apply at https://github.com/freeappstore-online/submissions/issues/new?template=creator-application.yml
2. Admin reviews and approves within 48h
3. Admin provisions the app via `POST /api/provision` (creates repo, hosting route, registry)
4. Creator is added to the `creators` team in the GitHub org
5. Creator clones the repo, writes code, pushes → live

**GitHub org teams:**
- `maintainers` — admins + AI agents, push access to ALL repos
- `creators` — approved builders, push access to THEIR repos only

**For AI agents helping a creator:** your job is to write code in the repo and push. The provisioning is already done. Don't try to create hosting routes or DNS records.

## Quick Reference

| | FreeAppStore (apps) | FreeGameStore (games) |
|---|---|---|
| **Domain** | freeappstore.online | freegamestore.online |
| **GitHub org** | freeappstore-online | freegamestore-online |
| **Store repo** | freeappstore-online/freeappstore | freegamestore-online/freegamestore |
| **Registry file** | `registry.json` in store repo | `registry.json` in store repo |
| **Templates** | template-standalone | template-game-canvas, template-game-cards, template-game-grid, template-game-3d |
| **SDK (connected apps)** | `@freeappstore/sdk` (auth, KV, counters, collections, rooms, roles, friends, proxy, keys, email, voice) | — || **Accent color** | Blue (#2563eb) | Emerald (#10b981) |
| **Logo** | Free **Apps** | Free **Games** |
| **Admin** | admin.freeappstore.online | admin.freegamestore.online |
| **Publish** | freeappstore.online/app/publish | publish.freegamestore.online |
| **Local path** | ~/dev/fas/ | ~/dev/fgs/ |
| **Storefront repo** | ~/dev/fas/freeappstore/ | ~/dev/fgs/freegamestore/ |

## Workspace Layout

Each app/game is its own GitHub repo. Clone whichever ones you work on flat under `~/dev/fas/` (or `~/dev/fgs/`):

```
~/dev/fas/                       ~/dev/fgs/
  freeappstore/   (storefront)     freegamestore/   (storefront)
  timer/                           chess/
  notes/                           tetris/
  calculator/                      racing/
  ...                              ...
```

The path is a suggestion, not a requirement — the CLI doesn't care where the repo lives. The convention just keeps apps and games visually separated when you have several.

## IMPORTANT: What NOT to do

- **Do NOT ask the user for Cloudflare API tokens, keys, or secrets.** Tokens are stored as org-level GitHub secrets and used only via GitHub Actions. Wrangler CLI uses its own OAuth. Never handle raw tokens.
- **Do NOT provision via `wrangler` or raw `curl`** — provisioning goes through the admin API / console publish page (see *Provisioning* below).
- **Do NOT deploy manually** — push to main triggers auto-deploy via GitHub Actions → R2. The only deploy is `git push`.
- **Do NOT use /ship or feature branches** — this platform uses trunk-based development. Push to main = deploy.
- **Do NOT create staging environments** — there's only production. Fix forward (revert commits are fine).
- **Do NOT set per-repo secrets** — use org-level secrets only (already configured in both orgs).

## How Deployment Works

```
Push to main → GitHub Actions builds → uploads to R2 → live
```

No manual deploy commands needed. The `deploy.yml` workflow in each repo builds on every push and uploads to R2. The host Worker serves the files from R2.

## Two distinct operations — don't confuse them

### 1. PROVISION (one-time setup for a new app)
Creates the GitHub repo, hosting route (subdomain → R2 prefix), and store listing.
This is done ONCE when a new app/game is created. Use the admin API, CLI (`fas publish`), or the console publish page.

### 2. DEPLOY (automatic on every push)
After provisioning, just push code to main. GitHub Actions builds and uploads to R2.
No API calls, no scripts, no manual steps. Just `git push`.

**As an AI agent: your job is to write code and push. Provisioning is handled by the admin API.**

## Provisioning a New App or Game

Provisioning is done by the **platform admin** or by the creator via the **console publish page**.

**As an AI agent, you do NOT provision apps.** Your job is:
1. Write code in an existing repo
2. Push to main
3. It auto-deploys

If the user wants a new app created, direct them to:
- **Self-service:** https://freeappstore.online/app/publish (sign in with GitHub, create instantly)
- **Admin:** https://admin.freeappstore.online (admin only)
- **From your editor:** the MCP `create_app` / `agent_build` tools provision + deploy directly (see *MCP Server* below)

Do NOT run curl commands against Cloudflare APIs. Do NOT use wrangler for provisioning. Do NOT ask for API tokens.

### After provisioning

The app repo exists with CLAUDE.md, template code, and auto-deploy configured.
Push any code to main → GitHub Actions builds → live at `<id>.freeappstore.online`.
No further API calls or manual steps needed. Ever.

## Platform Rules

- ONE environment: production only. Push to `main` = deploy. Fix forward.
- Static hosting on Cloudflare R2 (served by the host Worker). No server-side code in apps.
- Backend (if needed): `@freeappstore/sdk` (auth, KV, counters, collections, rooms, roles, friends, proxy, keys, email, voice). `npm i @freeappstore/sdk`.
- Free means free forever. No monetization in the free version.

## Tech Stack (required)

- TypeScript ^5.7, React ^19, Vite ^6, Tailwind CSS ^4.1, pnpm
- Node >=22
- 3D games: Three.js + React Three Fiber + Drei
- Games SDK: `@freegamestore/games` (GameShell, GameTopbar, GameButton)

## Project Structure

```
app-name/
├── package.json           (root workspace)
├── pnpm-workspace.yaml    (packages: [web])
├── LICENSE                (MIT)
├── .github/workflows/
│   ├── compliance.yml     (checks on PR)
│   └── deploy.yml         (auto-deploy on push)
└── web/
    ├── package.json
    ├── index.html
    ├── vite.config.ts
    ├── public/manifest.json
    └── src/
        ├── main.tsx
        ├── index.css      (Tailwind + brand CSS vars)
        ├── App.tsx        (renders <Shell> from @freeappstore/sdk/ui)
        └── components/    (your screens)
```

## SDK Setup (`@freeappstore/sdk`)

Connected apps use the platform SDK for auth, storage, real-time, and more. Install it:

```bash
pnpm add @freeappstore/sdk
```

Initialize once at app startup:

```tsx
import { initApp } from '@freeappstore/sdk'

const fas = initApp({ appId: 'my-app' })
// fas.auth     — GitHub OAuth sign-in/out
// fas.kv       — per-user key-value storage
// fas.counters — shared atomic counters
// fas.collections — document database
// fas.rooms    — real-time WebSocket rooms
// fas.friends  — platform-level friend relationships
// fas.proxy    — secret-injecting API proxy
```

The `appId` must match the subdomain (e.g. `'timer'` for `timer.freeappstore.online`).

### Auth

**Every app that requires sign-in must offer both GitHub and Google as login options.** GitHub is the developer default; Google covers the wider audience. Apple is optional but encouraged.

```tsx
// Imperative
fas.auth.signIn()           // redirects to GitHub OAuth
fas.auth.signIn('google')   // redirects to Google OAuth
fas.auth.signIn('apple')    // redirects to Apple OAuth (optional)
fas.auth.signOut()          // clears session
fas.auth.user               // { id, login, avatarUrl } | null
fas.auth.token              // session token string | null
fas.auth.onChange(listener)  // subscribe to auth state changes

// React hook (preferred)
import { useAuth } from '@freeappstore/sdk/hooks'
const { user, loading, signIn, signOut, deleteAccount, hasRole } = useAuth(fas)
// hasRole('moderator') — async, checks if current user has the role
```

When building a sign-in screen, always render both buttons:

```tsx
<button onClick={() => signIn('github')}>Sign in with GitHub</button>
<button onClick={() => signIn('google')}>Sign in with Google</button>
```

### Per-user KV Storage

Scoped per user per app. The user must be signed in.

```tsx
await fas.kv.set('preferences', { theme: 'dark', fontSize: 16 })
const prefs = await fas.kv.get('preferences')
await fas.kv.delete('preferences')
const keys = await fas.kv.list()
const filtered = await fas.kv.list({ prefix: 'draft:' })
const batch = await fas.kv.getMany(['k1', 'k2', 'k3'])
```

Limits: 1MB total per user, 100 keys max, 64KB per value, 128 char max key length. 100 active users/day, 1k ops/min per app.

### Shared Counters

Not user-scoped. Atomic. Anyone can read, auth required to write.

```tsx
const likes = await fas.counters.get('likes')           // public, no auth
await fas.counters.increment('likes')                    // +1, requires auth
await fas.counters.increment('score', 10)                // +10
await fas.counters.increment('lives', -1)                // decrement
const all = await fas.counters.list()                    // all counters
const votes = await fas.counters.list({ prefix: 'vote:' })
```

Use for: vote tallies, view counts, leaderboards, any shared numeric state.

### Collections (Document Database)

Firestore-style public queryable JSON documents with ownership.

```tsx
const col = fas.collections.collection('posts')

// Create (requires auth, auto-assigns id + owner)
const doc = await col.create({ title: 'Hello', body: 'World' })

// Read (public)
const post = await col.get(doc.id)

// Query (public, with filters)
const all = await col.query()
const mine = await col.query({ owner: fas.auth.user?.id })
const page2 = await col.query({ limit: 10, offset: 10, orderBy: 'created_at', order: 'desc' })

// Delete (owner only)
await col.delete(doc.id)
```

### Real-time Rooms (WebSocket)

Durable-Object-backed fan-out. Use for: cursor presence, multiplayer, chat, live collaboration.

```tsx
const room = fas.rooms.join('game-lobby')

room.onMessage((msg) => {
  console.log(msg.from.login, msg.data)  // { from: RoomPeer, data: T, at: number }
})

room.onPeers((peers) => {
  console.log('connected:', peers.map(p => p.login))
})

room.onState((state) => {
  // 'connecting' | 'open' | 'closed' | 'error'
})

room.send({ type: 'move', x: 10, y: 20 })
room.close()
```

Limits: 32 peers/room, 100 msg/sec/peer, 4KB max message, 64 active rooms/app, 24h idle eviction. Free tier: 5 rooms x 25 peers x 50 user-hours/day per app.

### Roles (App-level RBAC)

Per-app role management with default roles out of the box. Roles are scoped to your app and enforced server-side.

Default roles (no configuration needed): **owner** (auto-assigned to app creator), **member**, **moderator**, **editor**, **viewer**.

```tsx
// Assign a role
await fas.roles.assign(userId, 'moderator')

// Revoke a role
await fas.roles.revoke(userId, 'moderator')

// Check if the current user has a role (async — hits the API)
const isMod = await fas.roles.check('moderator') // true | false

// Get the current user's roles (async — hits the API)
const roles = await fas.roles.myRoles() // ['owner', 'moderator']

// Custom roles — pass any string
await fas.roles.assign(userId, 'beta-tester')
const isBeta = await fas.roles.check('beta-tester')
```

Use for: admin panels, moderation, content gating, feature flags by role. Custom roles work identically to the built-in defaults.

### Friends

Platform-level friend relationships. Friends are shared across all FreeAppStore apps.

```tsx
await fas.friends.list()                           // all accepted friends
await fas.friends.list('pending_incoming')         // incoming requests
await fas.friends.list('pending_outgoing')         // outgoing requests
await fas.friends.request(userId)                  // send friend request
await fas.friends.accept(userId)                   // accept request
await fas.friends.remove(userId)                   // remove friend
await fas.friends.search('username')               // search users

// React hook
import { useFriends } from '@freeappstore/sdk/hooks'
const { friends, incoming, outgoing, request, accept, remove } = useFriends(fas)
```

### Voice Input

Browser-native speech-to-text via Web Speech API. Graceful fallback when unsupported.

```tsx
import { useVoiceInput } from '@freeappstore/sdk/hooks'
const voice = useVoiceInput()
// voice.isSupported — boolean, true if browser supports speech recognition
// voice.isListening — boolean, true while actively recording
// voice.transcript — current speech text
// voice.start() — begin listening
// voice.stop() — stop listening

// Ready-made UI component
import { VoiceTextArea } from '@freeappstore/sdk/ui'
<VoiceTextArea value={text} onChange={setText} placeholder="Type or speak..." />
```

### Free APIs (no key required)

Many useful APIs require no API key. Prefer these first -- call them directly from the browser, no proxy needed.

| Category | API / Library | Notes |
|---|---|---|
| **Maps** | Leaflet + OpenStreetMap (`react-leaflet`) | `pnpm add leaflet react-leaflet`. No key. Best free-tier map. |
| **Charts** | Recharts (`recharts`) | `pnpm add recharts`. React charting. Bar, line, pie, area, radar. |
| **Rich text** | Tiptap (`@tiptap/react`) | `pnpm add @tiptap/react @tiptap/starter-kit`. Headless editor, extensible. |
| **Date/time** | date-fns (`date-fns`) | `pnpm add date-fns`. Lightweight, tree-shakable. No Moment.js. |
| **Markdown** | react-markdown (`react-markdown`) | `pnpm add react-markdown`. Render markdown as React components. |
| **PDF** | react-pdf or jsPDF | `pnpm add @react-pdf/renderer` (create) or `react-pdf` (view). |
| **QR codes** | qrcode.react (`qrcode.react`) | `pnpm add qrcode.react`. Generate QR codes as SVG/Canvas. |
| **Drag & drop** | dnd-kit (`@dnd-kit/core`) | `pnpm add @dnd-kit/core @dnd-kit/sortable`. Kanban, reorder lists. |
| **Animations** | Framer Motion (`framer-motion`) | `pnpm add framer-motion`. Layout animations, gestures, transitions. |
| **Icons** | Lucide React (`lucide-react`) | `pnpm add lucide-react`. 1500+ icons, tree-shakable, MIT. |
| **Forms** | React Hook Form (`react-hook-form`) | `pnpm add react-hook-form`. Performant forms with validation. |
| **State** | Zustand (`zustand`) | `pnpm add zustand`. Tiny state manager. Better than Redux for most apps. |
| Weather | Open-Meteo (`open-meteo.com`) | No key. 10k/day. Forecast, historical, air quality. |
| Geocoding | Nominatim (`nominatim.openstreetmap.org`) | No key. 1/sec. Set User-Agent header. |
| Routing | OSRM (`router.project-osrm.org`) | No key. Driving, cycling, walking directions. |
| Exchange rates | ExchangeRate-API (`open.er-api.com`) | No key. 1.5k requests/mo. |
| Country data | REST Countries (`restcountries.com`) | No key. Flags, currencies, languages, timezones. |
| Dictionary | Free Dictionary API (`dictionaryapi.dev`) | No key. Definitions, phonetics, audio. |
| Hacker News | Algolia HN API (`hn.algolia.com`) | No key. Search + front page + comments. |
| Wikipedia | MediaWiki API (`en.wikipedia.org/w/api.php`) | No key. Search, summaries, full articles. |
| Open Library | Open Library API (`openlibrary.org`) | No key. Book data, covers, full texts. |
| Random users | randomuser.me | No key. Fake user data for testing/demos. |
| Placeholder images | Lorem Picsum (`picsum.photos`) | No key. Random photos at any size. |
| Public datasets | data.gov, WHO, World Bank | Varies. Government + health + economic data. |

**Maps guidance:** Use Leaflet + OpenStreetMap (free, no API key) for the free tier. Google Maps requires a billing-enabled API key and is a `VITE_*` public config (see App Config section). If you need Google Maps, set `VITE_GOOGLE_MAPS_KEY` as a GitHub repo Variable restricted to `*.freeappstore.online` referrer.

### Secret-injecting API Proxy

For APIs that need a key, the proxy encrypts and injects it server-side. Two modes:

**Developer key** (all users share one key):
```tsx
// Developer sets key via Console or CLI: fas secret set WEATHER_KEY sk-...
const weather = await fas.proxy.fetch('api.openweathermap.org/data/2.5/weather?q=London')
const data = await weather.json()
```

**User key** (each user's own key, for AI providers):
```tsx
// User configures key on the platform key page
const res = await fas.proxy.fetch('api.openai.com/v1/chat/completions', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ model: 'gpt-4o-mini', messages: [{ role: 'user', content: 'Hello' }] }),
})
```

If the user has no key, the proxy returns `{ error: "no_key", provider: "openai" }`. Show `<KeyPrompt>` (see UI section).

**Pick the provider your users most likely already have.** OpenAI is the most common. Google AI (Gemini) has the most generous free tier. OpenRouter is a power-user option that gives access to 100+ models with one key. Default to OpenAI unless you have a reason not to.

### User API Key Vault

Users store their own API keys (OpenAI, Anthropic, etc.) on the platform. Apps never see the plaintext keys. Keys are encrypted at rest (AES-256-GCM envelope encryption) and injected server-side when apps call `fas.proxy.fetch()`. One key works across all apps on the platform.

```tsx
// Check if user has a key configured
const hasKey = await fas.keys.has('openai')

// Redirect user to platform key management page
fas.keys.manage('openai') // opens platform page, returns to app after

// Check all configured providers
const keys = await fas.keys.status()
// [{ provider: 'openai', label: 'My key', createdAt: ..., lastUsedAt: ... }]
```

Apps should use the `KeyPrompt` component (see UI section below) to show a prompt when a key is missing, rather than building custom key-entry UI.

### Transactional Email

Send email through the platform's Resend integration. No email provider setup needed.

```tsx
await fas.email.send('user@example.com', 'Welcome!', {
  html: '<h1>Welcome to my app!</h1><p>Thanks for signing up.</p>',
  text: 'Welcome to my app! Thanks for signing up.',
})
```

Subject is auto-prefixed with `[appId]`. Limit: 100 emails/day per app. Requires auth (user must be signed in).

### App Config & Secrets (what goes where)

Apps need three kinds of external values. Each has a different storage path:

| Kind | Examples | Where it goes | Reaches browser? |
|------|----------|--------------|-----------------|
| **Public identifiers** | OAuth client IDs, Firebase config, Stripe publishable keys, Google Maps browser key | **R2 deploy env vars** (`VITE_*` prefix) set in GitHub repo Settings > Secrets & Variables > Variables | Yes (build-time injection, origin-restricted server-side) |
| **Quota-bearing API keys** | OpenWeather, Last.fm, CoinGecko, any key where abuse = $ | **App-secret proxy** via `fas secret set NAME value` + allowlist rule | No (injected server-side by proxy) |
| **User-owned secrets** | OpenAI key, Anthropic key, Stripe secret key | **User key vault** via `fas.keys.manage()` | No (encrypted at rest, injected by proxy) |
| **Actual secrets** | OAuth client secrets, signing keys, admin tokens | **Platform-level wrangler secrets** (managed by admin, never in app code) | No |

**Rules:**
- `.env.production` must NEVER be committed (compliance check fails the build).
- `.env.local` is gitignored and safe for local dev.
- Public identifiers (`VITE_GOOGLE_CLIENT_ID`, `VITE_FIREBASE_*`) go in GitHub repo-level environment variables. They are injected at build time by the deploy workflow and are safe to expose in browser code (they are origin-restricted on the provider's side).
- If you are unsure whether a value is "public" or "secret", use the proxy. The proxy is always safer.

**Local development:**
```bash
# .env.local (gitignored, dev only)
VITE_GOOGLE_CLIENT_ID=123456789.apps.googleusercontent.com
VITE_FIREBASE_API_KEY=AIzaSy...
```

**Production:**
Set the same variables in your GitHub repo: Settings > Secrets and variables > Actions > Variables (not Secrets). The deploy.yml workflow passes them through at build time.

## What FAS cannot do (use ProAppStore instead)

FreeAppStore is free forever with real features, but some things need the Pro tier. If your app needs any of these, build on **[ProAppStore](https://proappstore.online)** instead.

| Need | FAS (free) | PAS (pro, $9/mo) |
|---|---|---|
| **Server-side AI** | User brings own key via vault | Platform-managed Workers AI (included) |
| **Real-time multiplayer** | Rooms: 32 peers, ephemeral | Server-authoritative DOs, persistent state |
| **Custom domain** | `appname.freeappstore.online` only | `your-domain.com` via CF for SaaS |
| **Scheduled tasks** | Not available | Cron Workers (digests, reminders, daily jobs) |
| **Transactional email** | 100/day per app via `fas.email.send()` | Higher quota (included) |
| **File storage** | Not available | R2 bucket per app (images, uploads, media) |
| **Server-side compute** | Static + client-side only | Per-app Worker with D1 database |
| **Monetization** | Free forever, no payments | Stripe integration, creator payouts |
| **User storage** | 1 MB/user, 100 keys | 10 MB/user, no key cap |
| **Source code** | MIT (open source required) | Proprietary allowed |

### Example: when to choose PAS over FAS

**AI writing app** -- FAS works if users bring their own OpenAI key (vault + proxy). But if you want to offer AI out of the box with zero setup, PAS includes Workers AI.

**Multiplayer game** -- FAS rooms are ephemeral (chat, cursors, lightweight). For turn-based games (chess vs a remote opponent) or persistent worlds, PAS gives you server-authoritative Durable Objects.

**SaaS with billing** -- FAS has no payments. PAS has Stripe subscriptions, license keys, and per-app creator payouts.

**Business app with cron** -- FAS apps are static. If you need daily email digests, scheduled reports, or background processing, PAS has Cron Workers.

**App with file uploads** -- FAS has no R2 storage. PAS gives each app its own R2 bucket for images, documents, and media.

**App needing a custom domain** -- FAS is subdomain-only. PAS supports `your-domain.com` via Cloudflare for SaaS Custom Hostnames.

### The upgrade path

FAS and PAS use the same SDK pattern (`initApp`, auth, KV, proxy). Moving an app from FAS to PAS means:
1. Change `@freeappstore/sdk` to `@proappstore/sdk` in `package.json`
2. Update `appId` domain from `freeappstore.online` to `proappstore.online`
3. Add PAS-only features (AI, cron, storage, payments)

The core app code stays the same. Auth, KV, collections, counters, and proxy all work identically on both platforms.

## App UI Components (`@freeappstore/sdk/ui` + `@freeappstore/sdk/hooks`)

**Connected apps MUST use the SDK components for auth, profile, and theme.** No custom sign-in buttons, no custom avatar components, no custom theme toggles. The SDK components enforce brand consistency and handle the full auth lifecycle (sign in, sign out, delete account, session management).

```bash
pnpm add @freeappstore/sdk
```

### Shell -- the app wrapper (every app starts here)

**Every app wraps itself in `Shell` with one `nav` entry per screen.** It provides: sticky topbar with brand logo + app name + text size + theme + ProfileMenu (or SignInButton when signed out), the app's main navigation from `nav` (`<nav aria-label="Main">`, current screen highlighted, a menu button on phones), and around your screens an error boundary, loading fallback, toast region, offline banner and skip link. Optional auth gate. Needs `@freeappstore/sdk` 0.14.30+. `FasShell` is the same component under its older name.

```tsx
import { useEffect, useState } from 'react'
import { initApp } from '@freeappstore/sdk'
import { type NavItem, PageHeader, Shell, useToast } from '@freeappstore/sdk/ui'

const fas = initApp({ appId: 'my-app' })

// One entry per screen. `title` becomes the browser tab title on that route.
const NAV: NavItem[] = [
  { label: 'Home', href: '/', title: 'My App' },
  { label: 'Settings', href: '/settings', title: 'Settings — My App' },
]

export default function App() {
  const [path, setPath] = useState(location.pathname)
  useEffect(() => {
    const sync = () => setPath(location.pathname)   // back/forward
    addEventListener('popstate', sync)
    return () => removeEventListener('popstate', sync)
  }, [])
  const navigate = (href: string) => { history.pushState(null, '', href); setPath(href) }

  return (
    <Shell app={fas} appName="My App" nav={NAV} onNavigate={navigate}>
      {path === '/settings' ? <Settings /> : <Home />}
    </Shell>
  )
}

function Home() {
  return <PageHeader title="Home" description="Your app starts here." />
}

function Settings() {
  const toast = useToast()
  return <PageHeader title="Settings" actions={<button onClick={() => toast.show('Saved', { variant: 'success' })}>Save</button>} />
}
```

Props:
- `app` -- the `FreeAppStore` instance from `initApp()`
- `appName` -- displayed in the topbar next to the brand logo
- `nav` -- the app's screens: `{ label, href, icon?, title? }[]`
- `onNavigate` -- client-side navigation for nav clicks (without it, nav items are ordinary links; the host serves the app for any path)
- `renderNav` -- replace the built-in navbar (still placed in the topbar)
- `requireAuth` -- if `true`, shows a sign-in screen instead of the app when not authenticated. Only for apps where everything needs an account; there is no paid tier or upgrade screen
- `showThemeToggle` -- theme toggle in the ProfileMenu dropdown (default `true`)
- `renderError` / `renderLoading` -- replace the error / loading fallback

Each screen starts with `<PageHeader title description? actions? />` (its single h1, and the focus target after navigation). `useToast()` raises feedback, `useDocumentTitle()` sets a screen's tab title, `useOnline()` reports the connection. Full guide: https://docs.freeappstore.online/getting-started/#build-your-app-on-the-shell

### Individual components

Use these inside `Shell`'s screens, or for layouts that don't use `Shell`. `Shell` uses the account components internally.

```tsx
import {
  Avatar, SignInButton, ThemeToggle, TextSizeToggle, ProfileMenu, ProfilePage,
  Spinner, Badge, Card, Tabs, Modal, ConfirmDialog, EmptyState, ProgressBar,
  SearchInput, ListRow, ErrorBoundary, KeyPrompt,
} from '@freeappstore/sdk/ui'
```

**Auth & profile:**

| Component | What it does | Key props |
|-----------|-------------|-----------|
| `Avatar` | GitHub avatar with colored-initial fallback | `user`, `size` (px, default 32) |
| `SignInButton` | Branded "Sign in with GitHub" button | `app`, `label` (override text) |
| `ThemeToggle` | Sun/moon button cycling system/light/dark | none (reads theme from context) |
| `TextSizeToggle` | A/A+/A- button cycling default/large/small text | none |
| `ProfileMenu` | Avatar dropdown (username, theme, API keys, sign out, delete account) | `app`, `showThemeToggle` |
| `ProfilePage` | Full-page settings view (avatar, username, theme selector, sign out, delete account) | `app`, `showThemeToggle` |

**Reusable building blocks:**

| Component | What it does | Key props |
|-----------|-------------|-----------|
| `Spinner` | Animated border spinner | `size` (px, default 24), `color` |
| `Badge` | Small pill badge for status/tags | `variant` (`default`\|`accent`\|`success`\|`warning`\|`danger`) |
| `Card` | Bordered surface card, optionally clickable | `onClick`, `padding`, `style` |
| `Tabs` | Pill-style tab selector | `tabs` (`[{key, label}]`), `active`, `onChange` |
| `Modal` | Centered modal with backdrop, Escape to close | `open`, `onClose`, `title`, `maxWidth` |
| `ConfirmDialog` | Confirm/cancel dialog built on Modal | `open`, `onConfirm`, `onCancel`, `title`, `message`, `variant` |
| `EmptyState` | Centered placeholder with icon and message | `icon`, `title`, `message`, `action` |
| `ProgressBar` | Horizontal progress bar | `value`, `max`, `color`, `height`, `label` |
| `SearchInput` | Input with magnifying glass icon | `value`, `onChange`, `placeholder` |
| `ListRow` | Clickable list row with icon/title/subtitle/trailing | `icon`, `title`, `subtitle`, `trailing`, `onClick` |
| `ErrorBoundary` | Catches render errors, shows fallback | `children`, `fallback` |
| `KeyPrompt` | Prompt when app needs a user's API key | `app`, `provider`, `providerName`, `message` |
| `Footer` | PWA footer with safe-area padding (standalone only) | `text` (default: "Part of FreeAppStore") |
| `BuildInfo` | Debug overlay (Alt+click or 5-tap to reveal) | `version`, `commit`, `buildDate`, `extra` |

**Footer behavior:** Only renders when the app is installed to the home screen (PWA standalone mode). Hidden in regular browser tabs where the browser provides its own bottom chrome. This prevents iPhone users from accidentally triggering Siri when tapping near the bottom of the screen. The Footer adds `env(safe-area-inset-bottom)` padding automatically to keep content out of the home indicator zone. Shell includes Footer automatically. Use `useStandalone()` hook if you need to detect standalone mode in custom layouts.

### Hooks

```tsx
import { useAuth, useTheme } from '@freeappstore/sdk/hooks'
```

| Hook | Returns | Use for |
|------|---------|---------|
| `useAuth(app)` | `{ user, loading, signIn, signOut, deleteAccount, hasRole }` | Auth state + actions. `hasRole(role)` is async. |
| `useTheme()` | `{ theme, preference, setPreference }` | Current theme ('light'\|'dark') + preference ('system'\|'light'\|'dark') |

### When to use Shell vs individual components

- **Every app:** Use `Shell` with `nav`. It handles the topbar, navigation, footer, auth gate, theme, error boundary and toasts in one wrapper. Both templates (`fas init`) already start inside it.
- **Custom navigation:** Keep `Shell` and pass `renderNav`, or use the exported `NavBar`.
- **Older apps** with a custom local shell or `FasShell` without `nav`: move to `Shell` with `nav`. See https://docs.freeappstore.online/ui/#migrating-to-the-shell

### What NOT to do

- Do NOT build a custom header, sidebar, tab bar, bottom dock or error boundary, and do NOT put navigation inside a screen. Use `Shell` with `nav`.
- Do NOT build custom sign-in buttons. Use `SignInButton` or `Shell`.
- Do NOT build custom avatar components. Use `Avatar`.
- Do NOT build custom theme toggles. Use `ThemeToggle`.
- Do NOT build custom profile/settings pages. Use `ProfilePage` or `ProfileMenu`.
- Do NOT handle sign-out or account deletion manually. The SDK components handle the full lifecycle including data cleanup.
- Do NOT build custom modals, spinners, tabs, badges, or search inputs. Use the SDK components.
- Do NOT build custom API key entry UI. Use `KeyPrompt` to redirect users to the platform key management page.

### Exports

| Import path | What you get |
|---|---|
| `@freeappstore/sdk` | `initApp`, `FreeAppStore`, types, roles, keys |
| `@freeappstore/sdk/hooks` | `useAuth`, `useTheme`, `useFriends`, `useVoiceInput` |
| `@freeappstore/sdk/ui` | `Shell` (alias `FasShell`), `PageHeader`, `NavBar`, `useToast`, `useDocumentTitle`, `useOnline`, `Avatar`, `SignInButton`, `ThemeToggle`, `TextSizeToggle`, `ProfileMenu`, `ProfilePage`, `Spinner`, `Badge`, `Card`, `Tabs`, `Modal`, `ConfirmDialog`, `EmptyState`, `ProgressBar`, `SearchInput`, `ListRow`, `ErrorBoundary`, `KeyPrompt`, `VoiceTextArea` |

## Games SDK (`@freegamestore/games`)

**Every game MUST use the SDK components.** No custom topbars, no custom shells. The SDK enforces brand consistency, viewport lock, and touch-friendly sizing across all games.

```bash
pnpm add @freegamestore/games
```

### GameShell — the root layout

Locks the game to `100svh`, prevents document scroll, disables text selection and touch callout. Every game wraps its content in this.

```tsx
import { GameShell, GameTopbar } from '@freegamestore/games';

export default function App() {
  return (
    <GameShell topbar={<GameTopbar title="Chess" score={42} />}>
      {/* your game canvas / DOM */}
    </GameShell>
  );
}
```

Hard guarantees:
- `height: 100svh`, `overflow: hidden` — no document scroll, ever
- `user-select: none` — no accidental text selection during gameplay
- `touch-action: manipulation` — no 300ms tap delay
- `-webkit-touch-callout: none` — no long-press context menus

### GameTopbar — the status bar

The **only** allowed topbar. Same font, padding, color tokens across every game.

```tsx
// Simple: just a score
<GameTopbar title="Tetris" score={42} />

// Custom stats: level, lives, time
<GameTopbar
  title="Pac-Man"
  stats={[
    { label: 'Score', value: 1200, accent: true },
    { label: 'Lives', value: 3 },
    { label: 'Level', value: 5 },
  ]}
  actions={<GameButton size="sm" variant="ghost" onClick={pause}>Pause</GameButton>}
/>
```

Props:
- `title` — game name, left side, Fraunces 700
- `score` — convenience for single-score games
- `stats` — custom stat lineup (replaces score)
- `actions` — right-side buttons (max 2)

### GameButton — prescribed touch-friendly buttons

Min 44px touch target. Three variants, three sizes — nothing custom.

```tsx
import { GameButton } from '@freegamestore/games';

<GameButton variant="primary" size="md" onClick={start}>Play Again</GameButton>
<GameButton variant="secondary" size="sm" onClick={undo}>Undo</GameButton>
<GameButton variant="ghost" size="sm" onClick={flip}>Flip</GameButton>
```

| Size | Min height | Use case |
|------|-----------|----------|
| `sm` | 44px | In-game controls, topbar actions |
| `md` | 48px | Primary actions, menus |
| `lg` | 56px | Start screen, game over CTA |

Variants: `primary` (accent bg), `secondary` (outline), `ghost` (text only).

### useSound — muted by default

Every game is muted by default. The SDK provides the sound toggle in the topbar automatically — devs cannot remove it.

```tsx
import { useSound } from '@freegamestore/games';

function MyGame() {
  const { muted } = useSound();
  // Check muted before playing any audio
  if (!muted) playSound();
}
```

- Games MUST respect the `muted` state — never play audio when `muted === true`
- The toggle is in the topbar, managed by the SDK
- Default is ALWAYS muted — no exceptions

### What NOT to do

- Do NOT build custom Shell or topbar components — use the SDK
- Do NOT override `user-select`, `touch-action`, or `overflow` on the root — GameShell handles it
- Do NOT pass custom colors to topbar or buttons — they use platform CSS tokens
- Do NOT play audio without checking `useSound().muted` first
- Do NOT add your own mute button — the SDK handles it

## No Splash Screens

Games must show the actual game field immediately on load. No title screens, no "Start Game" buttons covering the viewport, no introductory pages.

**Rules:**
- The game board/field/canvas MUST be visible from the first render
- For time-sensitive games (Tetris, Snake, Pac-Man): show the game field with a semi-transparent "Tap to play" overlay. The field is visible underneath.
- For turn-based games (Chess, Sudoku, Minesweeper): start the game immediately, no overlay needed
- Game-over screens can show a "Play Again" button — that's fine, it's after gameplay
- Difficulty selectors, theme pickers, and settings belong in the topbar or rules overlay — not as a splash screen

**Bad (splash screen):**
```
┌──────────────────┐
│                  │
│     Snake        │
│                  │
│  [Start Game]    │
│                  │
└──────────────────┘
```

**Good (game field visible, play overlay):**
```
┌──────────────────┐
│  ●               │
│    ■■■■          │
│         ┌──────┐ │
│         │ Play │ │
│         └──────┘ │
│                  │
└──────────────────┘
```

## Mobile-First Testing

FreeGameStore is a **mobile-first gaming platform**. Test on phone viewports first. Desktop is secondary.

### Quality Auditor

The platform runs an internal Playwright auditor against every live game at mobile viewports. **Any scroll = fail.** You don't run this yourself — it runs against your URL after deploy and the result determines whether your game stays in the registry.

What you *can* run pre-publish, locally, is the same scroll check on a single viewport:

```bash
# Apps:
fas screencheck

# Games:
fgs screencheck
```

It builds, serves, drives a real Chromium at the declared `min_viewport_width` in portrait + landscape, and fails if the page scrolls. Recommended before every publish.

### Reference viewports (mobile priority)

The auditor tests 12 viewports. Mobile phones are weighted highest:

| Viewport | Device | Share | Priority |
|----------|--------|-------|----------|
| 320×568 | iPhone SE | 99% | **Critical** |
| 360×800 | Android | 96% | **Critical** |
| 393×852 | iPhone 15 | 92% | **Critical** |
| 414×896 | iPhone 11 PM | 88% | High |
| 568×320 | iPhone SE landscape | 99% | **Critical** |
| 667×375 | iPhone 8 landscape | 96% | **Critical** |
| 736×414 | iPhone+ landscape | 88% | High |
| 600×800 | Tablet portrait | 60% | Medium |
| 768×1024 | iPad portrait | 35% | Low |
| 1024×768 | iPad landscape | 35% | Low |
| 1024×1366 | iPad Pro portrait | 20% | Low |
| 1366×1024 | iPad Pro landscape | 20% | Low |

**Score = worst orientation's max-passing-share.** If landscape fails at all phone sizes, score plummets even if portrait is perfect.

### Rules

- Game must fit viewport with **zero scroll** at every size from 320×568 up
- `html`, `body`, `#root` must have `overflow: hidden`
- Use `100dvh` or `100svh` (not `100vh` — iOS Safari URL bar bug)
- Canvas/game area must scale to available space, not use fixed pixel sizes
- Buttons must be minimum 44px touch target

## Brand Design

- Fonts: Manrope (body) + Fraunces (display, 700-800)
- CSS Variables: `--paper`, `--ink`, `--muted`, `--line`, `--line-strong`, `--panel`, `--accent`, `--success`, `--warning`, `--danger` (never the banned aliases `--bg`, `--surface`, `--border`, `--glass`, `--dock`, `--error`)
- Apps layout: the SDK `Shell` (topbar with the app's navigation, then the screen). See "Shell -- the app wrapper" above.
- Games layout: GameShell + GameTopbar (no sidebar, no dock — fullscreen)
- Dark mode: `:root[data-theme='dark']` (the SDK sets it from the system or the Shell's theme toggle)
- Border radius: 1.25rem cards, 0.75rem buttons

## Privacy Rules

- ZERO analytics, tracking, cookies
- All user data in localStorage (standalone) or `@freeappstore/sdk` KV (connected)
- No third-party scripts except Google Fonts CDN

## Compliance Checks (automated on push)

The canonical list lives in [`workflows/compliance.yml`](./workflows/compliance.yml) — that's the source of truth (this list will drift; the YAML won't):

- `pnpm build` passes
- MIT `LICENSE` file exists
- No `.env.production` committed (use GitHub repo variables for `VITE_*` public config instead; see "App Config & Secrets" section)
- No tracking SDKs (google-analytics, gtag, amplitude, mixpanel, segment, hotjar, plausible, posthog)
- Brand fonts (Manrope + Fraunces) referenced in `web/src/index.css`
- Brand CSS variables (`--paper`, `--ink`, `--accent`) present
- HTML `lang`, `viewport`, and `<title>` in `web/index.html`
- PWA `manifest.json` with `name`/`display`/`start_url`
- Mobile-web-app meta tags
- `freeappstore.online` link somewhere in `web/src/`
- Dark-mode support (`prefers-color-scheme` / `data-theme` / `color-scheme`)
- Root pnpm workspace (`pnpm-workspace.yaml` + `pnpm` in `package.json`)
- Largest JS asset under 300KB gzipped (307200 bytes)

### Runtime viewport check (pre-publish)

`fas check` is static. To prove the app *actually* fits at its declared `min_viewport_width`, run **`fas screencheck`** (or `fgs screencheck` for games). It builds, serves the dist, drives a real Chromium at the declared min in portrait + landscape, and fails if the page scrolls. Playwright is an opt-in peer dep — first run prompts you to install it. Recommended before every publish, especially for games.

## Game-specific UI primitives

Games on FreeGameStore use **`@freegamestore/games`** for layout + topbar:

```tsx
import { GameShell, GameTopbar } from '@freegamestore/games';

export default function App() {
  return (
    <GameShell topbar={<GameTopbar title="Tetris" score={42} />}>
      {/* your canvas / game DOM */}
    </GameShell>
  );
}
```

- `<GameShell>` hard-locks the layout to `100svh` and prevents overflow at every level — no document scroll, ever.
- `<GameTopbar>` is the **only** allowed topbar shape. Pass `score` for the simple case, or `stats={[…]}` for games that show level / lives / time.
- Both honor the platform CSS tokens. Don't pass custom colors.

## CLI Reference (`@freeappstore/cli`)

```bash
npm i -g @freeappstore/cli
```

| Command | What it does |
|---------|-------------|
| `fas login` | GitHub OAuth device flow, caches token at `~/.fas/config.json` |
| `fas logout` | Clear saved session |
| `fas whoami` | Print signed-in GitHub user |
| `fas init <id>` | Scaffold from template (`--template standalone\|connected\|game-canvas\|game-grid\|game-3d`) |
| `fas check` | Run compliance checks (brand, bundle size, PWA, tracking, license) |
| `fas screencheck` | Build + viewport test in real Chromium (portrait + landscape) |
| `fas publish` | Provision repo + hosting + DNS + store listing. Flags: `--name`, `--category`, `--type`, `--oneliner`, `--demo`, `--yes`, `--skip-checks`, `--issue` |
| `fas list` | List your published apps (`--json` for machine output) |
| `fas doctor` | Health check: Node, git, pnpm, auth, API reachability |

The command is `fas init`, not `fas create`. If you see `fas create` in old docs, it's outdated.

## MCP Server

The FreeAppStore MCP server lets an AI agent drive the **full app lifecycle from inside your editor** — not just read-only info. Endpoint: `https://mcp.freeappstore.online/mcp` (Streamable HTTP).

### Connect

**Claude Code:**
```bash
claude mcp add freeappstore -- npx mcp-remote https://mcp.freeappstore.online/mcp
```

**Cursor / any MCP client** (config form):
```json
{
  "mcpServers": {
    "freeappstore": {
      "command": "npx",
      "args": ["mcp-remote", "https://mcp.freeappstore.online/mcp"]
    }
  }
}
```

### Authentication

Read-only tools (`platform_guide`, `sdk_reference`, `list_apps`, `app_info`, `deploy_status`) work unauthenticated. Tools that **build, mutate, or inspect repo contents** need a FAS session token — the same token `fas login` caches at `~/.fas/config.json`. Pass it as a bearer header through `mcp-remote`:

```bash
TOKEN=$(jq -r .token ~/.fas/config.json)
claude mcp add freeappstore -- \
  npx mcp-remote https://mcp.freeappstore.online/mcp \
  --header "Authorization: Bearer $TOKEN"
```

### Two ways to build an app over MCP

The MCP supports both "I write the code" and "the platform writes the code":

1. **Your AI writes the code, MCP ships it.** Use `create_app` to provision + scaffold + deploy, then `update_files` / `read_file` / `list_files` to iterate on the repo. You author every file; the MCP just provisions and pushes.
2. **You prompt, the platform's VibeCode agent writes + deploys it.** Use `agent_build` with a natural-language prompt — the server-side VibeCode agent writes the code and deploys it for you, using *your* vaulted AI key (so the provider you pick must match a key in your vault). Poll with `agent_status`.

### Tool reference

**Build & ship (auth required):**

| Tool | Signature | What it does |
|---|---|---|
| `create_app` | `(app_id, category, oneliner, type?, description?)` | Provision + scaffold + deploy. Goes live at `<app_id>.freeappstore.online`. `type` is `standalone` (no backend) or `connected` (SDK). |
| `update_files` | `(app_id, files: [{path, content}], message?)` | Push file edits to the repo; auto-redeploys. Owner only. |
| `read_file` | `(app_id, path)` | Read one file from an app repo. |
| `list_files` | `(app_id)` | List the file tree of an app repo. |

**VibeCode agent (auth required):**

| Tool | Signature | What it does |
|---|---|---|
| `agent_build` | `(prompt, provider?, model?, session_id?)` | The platform's VibeCode agent writes + deploys an app from your prompt. `provider` is `anthropic`\|`openai`\|`openrouter`\|`google` and must match a key in your vault. Pass `session_id` to continue an existing build. |
| `agent_status` | `(session_id)` | Poll a running `agent_build`. |

**Inspect & reference:**

| Tool | Signature | What it does |
|---|---|---|
| `list_apps` | `()` | Your published apps. |
| `app_info` | `(app_id)` | Registry + metadata for one app. |
| `deploy_status` | `(app_id)` | Latest deploy state. |
| `app_logs` | `(app_id, level?, limit?)` | Recent app logs. |
| `platform_guide` | `()` | Returns this guide. |
| `sdk_reference` | `(feature?)` | SDK docs, optionally scoped to one feature (`auth`, `kv`, `rooms`, …). |

### Examples (one prompt per mode)

```
# Mode 1 — your AI writes it, MCP ships it
create_app(app_id="habit-tracker", category="productivity",
           oneliner="Track daily habits with streaks", type="connected")
# then iterate:
update_files(app_id="habit-tracker",
             files=[{path:"web/src/App.tsx", content:"…"}],
             message="Add streak counter")

# Mode 2 — you prompt, the VibeCode agent writes + deploys it
agent_build(prompt="A pomodoro timer with a focus log and dark mode",
            provider="anthropic")
agent_status(session_id="…")   # poll until deployed
```

## Infrastructure

Infrastructure is managed by the admin. AI agents do NOT need access to:
- Cloudflare API tokens or keys
- DNS management
- Hosting route or R2 bucket creation
- GitHub secrets

All of this is handled automatically by the provisioning system and GitHub Actions.

## Support

Direct creators and users to the right place:

| Need | Where |
|------|-------|
| **Developer questions** | [GitHub Discussions](https://github.com/freegamestore-online/freegamestore/discussions) (games) or [GitHub Discussions](https://github.com/freeappstore-online/freeappstore/discussions) (apps) |
| **Bug reports** | Open an issue on the game/app's GitHub repo |
| **Feature ideas** | Discussions → Ideas category |
| **Creator applications** | [Submissions repo](https://github.com/freeappstore-online/submissions/issues/new) |
| **Platform docs** | This file (SKILLS.md) |

Do NOT send users to email, Slack, Discord, or any external service. All support is on GitHub.

## Quality API

Every app gets a VCQA code health score computed at deploy time.

```
GET https://api.freeappstore.online/v1/apps/{id}/quality     → JSON report
GET https://api.freeappstore.online/v1/apps/{id}/quality/badge → SVG badge
```

Embed the badge in your README:
```markdown
![Code Quality](https://api.freeappstore.online/v1/apps/YOUR_APP_ID/quality/badge)
```
