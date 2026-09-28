// The @freeappstore/sdk reference the MCP hands to connecting AIs (#91). Apps
// built over the MCP only use the Shell, its navbar and the SDK components if
// this output tells the building AI they exist, so every build path (the
// reference, platform_guide, create_app) leads with the Shell and real nav.

/**
 * The build hand-off every create-app path returns: what the calling AI must do
 * first, before writing any screen.
 */
export const BUILD_HANDOFF_BLOCK = `## Build it on the Shell (required)
1. Wrap the whole app in \`<Shell>\` from "@freeappstore/sdk/ui" with a \`nav\` entry for every screen:
   \`<Shell app={fas} appName="My App" nav={NAV} onNavigate={navigate}>\`. The Shell renders the topbar
   (FreeAppStore link, sign-in / profile menu, theme, text size) and the navigation as
   \`<nav aria-label="Main">\`. Do this first, on the first render, even for a one-screen app.
2. Start each screen with \`<PageHeader title="…" />\` (its one h1). Use \`useToast\` for feedback.
3. Build screens from the SDK components (\`sdk_reference\` feature "components"). Never hand-roll a
   header, sidebar, tab bar, bottom dock or error boundary, and never put navigation inside a screen.
4. FreeAppStore is free: no subscription, paywall or upgrade screen. Leave \`requireAuth\` off unless
   the whole app needs sign-in.
Full example: \`sdk_reference\` feature "shell".`;

const SHELL = `## Shell: the standard app frame (start here)
Every FreeAppStore app wraps itself in \`Shell\`. It is the frame that stays put while screens change:
topbar, main navigation, error boundary, loading fallback, toasts, offline banner and skip link.
Build screens inside it; never build your own header or navbar.

\`\`\`tsx
import { useEffect, useState } from 'react'
import { initApp } from '@freeappstore/sdk'
import { type NavItem, PageHeader, Shell, useToast } from '@freeappstore/sdk/ui'

const fas = initApp({ appId: 'my-app' })

// One entry per screen. \`title\` becomes the browser tab title on that route.
const NAV: NavItem[] = [
  { label: 'Notes', href: '/', title: 'Notes' },
  { label: 'Tags', href: '/tags', title: 'Tags — Notes' },
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
    <Shell app={fas} appName="Notes" nav={NAV} onNavigate={navigate}>
      {path === '/tags' ? <Tags /> : <Notes />}
    </Shell>
  )
}

function Tags() {
  const toast = useToast()
  return (
    <>
      <PageHeader title="Tags" actions={<button onClick={() => toast.show('Saved', { variant: 'success' })}>Save</button>} />
      {/* screen content, built from the SDK components */}
    </>
  )
}
\`\`\`

### How do I add navigation?
- List every screen in \`nav\` (\`{ label, href, icon?, title? }\`). The Shell renders it in the topbar as
  \`<nav aria-label="Main">\`, marks the current screen \`aria-current="page"\` (\`/tags/42\` marks \`/tags\`),
  collapses to a menu button on phones, and is keyboard and screen-reader operable.
- \`onNavigate(href)\` makes nav clicks client-side (pushState + your route state, or a router's
  \`navigate\`). Without it the items are ordinary links; the host serves the app for any path, so render
  the screen for \`location.pathname\`.
- \`renderNav({ items, currentPath, onNavigate })\` replaces the built-in navbar; the result still goes in
  the topbar. Render a \`<nav aria-label="Main">\`.
- Never put navigation inside a screen, and never add a second bar, sidebar or bottom dock.

### Built in (nothing to enable)
- Error boundary: a screen that throws shows "Try again" instead of a white page; the topbar stays. The
  error is logged to \`fas.log\` (category \`react.error-boundary\`). \`renderError({ error, reset })\` replaces it.
- Loading: a \`<Suspense>\` spinner while a \`React.lazy\` screen loads. \`renderLoading()\` replaces it.
- Toasts: one polite live region. \`const toast = useToast(); toast.show('Saved', { variant: 'success' })\`
  (variants info | success | error; \`duration\` ms, 0 = until dismissed). Only inside Shell.
- Offline banner under the topbar while the connection is down. \`useOnline()\` gives screens the same signal.
- Tab title per route: \`title\` on a nav item, or \`useDocumentTitle('…')\` in the screen (wins).
- Skip link to \`<main id="main">\`. With \`onNavigate\`, route changes scroll to the top (back/forward restores
  the position) and move focus to the new screen's \`PageHeader\`.

### Shell props
| Prop | |
|---|---|
| \`app\` | The \`initApp()\` instance. Required. |
| \`appName\` | Shown in the topbar. |
| \`nav\` | The app's screens: \`NavItem[]\`. |
| \`onNavigate(href)\` | Client-side navigation for nav clicks. |
| \`renderNav(ctx)\` | Replace the built-in navbar. |
| \`requireAuth\` | Show a sign-in screen until the user signs in. Default false. |
| \`showThemeToggle\` | Default true. |
| \`renderError(ctx)\` / \`renderLoading()\` | Replace the error / loading fallback. |

FreeAppStore is free: there is no paid tier, subscription or upgrade screen. The only gate is
\`requireAuth\`; use it only when the whole app needs sign-in (most apps work signed out with
localStorage). \`FasShell\` is the same component under its older name.`;

/** Every export of @freeappstore/sdk/ui, with its props. */
const COMPONENTS = `## Components (@freeappstore/sdk/ui)
Everything below imports from '@freeappstore/sdk/ui'. Components use the CSS tokens (--ink, --accent, …)
so they follow the app's light/dark theme. Prefer them to hand-rolled equivalents.

**App frame and screens**
- \`Shell\` (alias \`FasShell\`) — the app frame; see feature "shell". Props: app, appName?, nav?, onNavigate?, renderNav?, requireAuth?, showThemeToggle?, renderError?, renderLoading?
- \`PageHeader\` — a screen's single h1. Props: title, description?, actions?
- \`NavBar\` — the navbar Shell renders from \`nav\`, for custom layouts. Props: items, currentPath?, onNavigate?
- \`activeHref(items, path)\` — which nav item is current. \`useCurrentPath()\` — [path, setPath], follows back/forward.
- \`OfflineBanner\` — the offline notice Shell shows; for layouts without Shell.

**Feedback**
- \`useToast()\` — { show(message, { variant?, duration? }), dismiss(id) }. Inside Shell only.
- \`Spinner\` — size?, color?
- \`ProgressBar\` — value, max?, color?, height?, label?
- \`Badge\` — children, variant? ('default' | 'accent' | 'success' | 'warning' | 'danger')
- \`EmptyState\` — message, title?, icon?, action?
- \`ErrorBoundary\` — children, fallback? (Shell already has one around every screen)

**Content**
- \`Card\` — children, onClick?, padding?
- \`ListRow\` — title, subtitle?, icon?, trailing?, onClick?
- \`Tabs\` — tabs: { key, label }[], active, onChange (for switching within one screen; screens go in \`nav\`)
- \`SearchInput\` — value, onChange, placeholder?

**Overlays**
- \`Modal\` — open, onClose, children, title?, maxWidth?
- \`ConfirmDialog\` — open, onConfirm, onCancel, title, message, confirmLabel?, variant? ('danger' | 'default')

**Account (Shell's topbar already has these)**
- \`SignInButton\` — app, label?
- \`Avatar\` — user, size?
- \`ProfileMenu\` — app, showThemeToggle?, children?
- \`ProfilePage\` — app, showThemeToggle?
- \`ThemeToggle\`, \`TextSizeToggle\` — no props. \`useTextSize()\` — the text size preference.

**Friends**
- \`FriendsList\` — app, onSelectFriend?
- \`AddFriendButton\` — app, userId
- \`FriendRequestBadge\` — app

**Voice** (with \`useVoiceInput\` from '@freeappstore/sdk/hooks')
- \`VoiceButton\` — voice, disabled?, size?
- \`VoiceTextArea\` — value, onChange, voice, placeholder?, disabled?, rows?, onSubmit?

**API keys and info**
- \`KeyPrompt\` — app, provider, providerName?, message? (asks the user to add a key to their vault)
- \`BuildInfo\` — version?, commit?, buildDate?, extra?
- \`Footer\` — text? (Shell includes it)

**Hooks**
- \`useDocumentTitle(title)\` — the tab title for the current screen.
- \`useOnline()\` — whether the browser is online.
- \`useStandalone()\` — whether the app runs installed (PWA standalone).`;

const SECTIONS = {
  shell: SHELL,
  components: COMPONENTS,
  auth: `## Auth
\`\`\`tsx
import { initApp } from '@freeappstore/sdk'
const fas = initApp({ appId: 'my-app' })
// fas.auth.signIn()  — GitHub OAuth
// fas.auth.signOut()
// fas.auth.token     — current session token (string | null)
// fas.auth.user      — current user ({ id, login, avatarUrl } | null)
\`\`\``,
  kv: `## Per-user KV Storage
\`\`\`tsx
await fas.kv.set('key', { any: 'json' })
const val = await fas.kv.get('key')
await fas.kv.delete('key')
const keys = await fas.kv.list()                // all keys
const filtered = await fas.kv.list({ prefix: 'draft:' })
const many = await fas.kv.getMany(['k1', 'k2']) // batch read
\`\`\`
Limits: 1MB/user, 100 active users/day, 1k ops/min.`,
  counters: `## Shared Counters
\`\`\`tsx
const count = await fas.counters.get('likes')        // public, no auth
await fas.counters.increment('likes')                 // +1, requires auth
await fas.counters.increment('score', 10)             // +10
await fas.counters.increment('lives', -1)             // decrement
const all = await fas.counters.list()                 // all counters
const filtered = await fas.counters.list({ prefix: 'vote:' })
\`\`\`
Not user-scoped. Atomic. Use for votes, views, leaderboards.`,
  collections: `## Collections (Document Database)
\`\`\`tsx
const doc = await fas.collections.create('posts', { title: 'Hello', body: '...' })
const post = await fas.collections.get('posts', doc.id)
const all = await fas.collections.list('posts')
const mine = await fas.collections.list('posts', { mine: true })
await fas.collections.update('posts', doc.id, { title: 'Updated' })
await fas.collections.delete('posts', doc.id)
\`\`\`
Firestore-style. Public queryable JSON documents with ownership.`,
  rooms: `## Real-time Rooms (WebSocket)
\`\`\`tsx
const room = fas.rooms.join('my-room')
room.onMessage((msg) => console.log(msg.from.login, msg.data))
room.onPeers((peers) => console.log('peers:', peers))
room.onState((state) => console.log('connection:', state))
room.send({ type: 'move', x: 10, y: 20 })
room.leave()
\`\`\`
Limits: 5 rooms x 25 peers x 50 user-hours/day per app.`,
  proxy: `## Secret-injecting API Proxy
\`\`\`tsx
const weather = await fas.proxy.fetch('api.openweathermap.org/data/2.5/weather?q=London')
const data = await weather.json()
\`\`\`
Calls third-party APIs without exposing keys. Developer keys configured by platform admin, user keys stored in the key vault.`,
  keys: `## User API Key Vault
\`\`\`tsx
// Check if user has a key
const hasKey = await fas.keys.has('openai')

// Redirect to platform key management page
fas.keys.manage('openai')

// Check all configured providers
const keys = await fas.keys.status()
// [{ provider: 'openai', label: '...', createdAt: ..., lastUsedAt: ... }]
\`\`\`
Users store their API keys on the platform (encrypted AES-256-GCM). Apps never see plaintext keys. Use \`<KeyPrompt>\` component to prompt users when a key is missing. Supported providers: OpenAI, Anthropic, Google AI, OpenRouter, Replicate, Stability AI, ElevenLabs, Stripe.`,
  hooks: `## React Hooks
\`\`\`tsx
import { useAuth, useTheme } from '@freeappstore/sdk/hooks'

const { user, loading, signIn, signOut, deleteAccount } = useAuth(fas)
const { theme, preference, setPreference } = useTheme()

// Screen helpers, from '@freeappstore/sdk/ui' (inside Shell):
import { useToast, useDocumentTitle, useOnline } from '@freeappstore/sdk/ui'
const toast = useToast()               // toast.show('Saved', { variant: 'success' })
useDocumentTitle('Tags — Notes')       // tab title for this screen
const online = useOnline()             // false while the connection is down
\`\`\``,
  ui: `## UI Components
\`\`\`tsx
import {
  Shell, PageHeader, NavBar, useToast, useDocumentTitle, useOnline,
  Avatar, SignInButton, ThemeToggle, ProfileMenu, ProfilePage,
  Spinner, Badge, Card, Tabs, Modal, ConfirmDialog, EmptyState,
  ProgressBar, SearchInput, ListRow, ErrorBoundary, KeyPrompt,
} from '@freeappstore/sdk/ui'

// The app frame (see feature "shell"): topbar, navigation, error boundary, toasts
<Shell app={fas} appName="My App" nav={NAV} onNavigate={navigate}>{screens}</Shell>

// Each screen:
<PageHeader title="Tags" description="Group your notes" actions={<button>New</button>} />

// Building blocks:
<Spinner size={24} />
<Badge variant="success">Live</Badge>
<Card onClick={handleClick}>content</Card>
<Tabs tabs={[{key:'a',label:'Tab A'},{key:'b',label:'Tab B'}]} active="a" onChange={setTab} />
<Modal open={isOpen} onClose={close} title="Settings">content</Modal>
<ConfirmDialog open={show} onConfirm={ok} onCancel={cancel} title="Delete?" message="Are you sure?" variant="danger" />
<EmptyState message="No items yet" action={<button>Add one</button>} />
<ProgressBar value={75} label="Upload" />
<SearchInput value={query} onChange={setQuery} />
<ListRow title="Item" subtitle="description" onClick={handleClick} />
<KeyPrompt app={fas} provider="openai" providerName="OpenAI" />
\`\`\`
Every export with its props: feature "components".`,
  "free-apis": `## Free Libraries & APIs (no key needed)

**Client-side libraries** (install and use directly):
- **Maps:** Leaflet + OpenStreetMap (\`pnpm add leaflet react-leaflet\`)
- **Charts:** Recharts (\`pnpm add recharts\`)
- **Rich text:** Tiptap (\`pnpm add @tiptap/react @tiptap/starter-kit\`)
- **Date/time:** date-fns (\`pnpm add date-fns\`)
- **Markdown:** react-markdown (\`pnpm add react-markdown\`)
- **PDF:** react-pdf or jsPDF (\`pnpm add @react-pdf/renderer\`)
- **QR codes:** qrcode.react (\`pnpm add qrcode.react\`)
- **Drag & drop:** dnd-kit (\`pnpm add @dnd-kit/core @dnd-kit/sortable\`)
- **Animations:** Framer Motion (\`pnpm add framer-motion\`)
- **Icons:** Lucide React (\`pnpm add lucide-react\`) — 1500+ icons
- **Forms:** React Hook Form (\`pnpm add react-hook-form\`)
- **State:** Zustand (\`pnpm add zustand\`)

**Free APIs** (no key, call directly from browser):
- Weather: Open-Meteo, Geocoding: Nominatim, Routing: OSRM
- Exchange rates: ExchangeRate-API, Countries: REST Countries
- Dictionary: dictionaryapi.dev, Hacker News: hn.algolia.com
- Wikipedia: MediaWiki API, Open Library: openlibrary.org
- Random users: randomuser.me, Images: picsum.photos

Prefer these before using the proxy. No key = no cost = no setup.`,
} as const;

export type SdkReferenceFeature = keyof typeof SECTIONS;

/** Feature names in output order: `shell` and `components` lead. */
export const SDK_REFERENCE_FEATURES = Object.keys(SECTIONS) as [SdkReferenceFeature, ...SdkReferenceFeature[]];

/** The sdk_reference tool's text for one feature, or every section (shell first) for "all"/none. */
export function getSdkReference(feature?: string): string {
  const selected =
    !feature || feature === "all"
      ? Object.values(SECTIONS).join("\n\n")
      : (SECTIONS as Record<string, string>)[feature] ?? `Unknown feature: ${feature}`;
  return `# @freeappstore/sdk Reference\n\n${selected}`;
}

/** platform_guide's output: the fetched guide, then the build hand-off, which wins over it. */
export function withBuildHandoff(guide: string): string {
  return `${guide}\n\n---\n\n# Current app-building rules (supersede any older shell/layout guidance above)\n\n${BUILD_HANDOFF_BLOCK}`;
}
