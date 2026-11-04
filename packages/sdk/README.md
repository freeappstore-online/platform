# @freeappstore/sdk

Browser SDK for free apps published on **freeappstore.online**.

PWA lifecycle APIs live at `@freeappstore/sdk/pwa`, with Vite options at
`@freeappstore/sdk/pwa-config`. See [safe updates and offline capabilities](https://github.com/freeappstore-online/platform/blob/main/docs/pwa-lifecycle.md).

Device-local preferences, IndexedDB, and large-file metadata live at
`@freeappstore/sdk/persist`. That data is not the signed-in account. Account
keys remain `fas.kv`. A failed save returns a status instead of throwing a
success path, and corrupt values are left in place. See
[device-local persistence](https://github.com/freeappstore-online/platform/blob/main/docs/sdk.md#device-local-persistence-freeappstoresdkpersist).

Validated backup, import, and browser file export live at `@freeappstore/sdk/backup`.
This subpath requires `@freeappstore/sdk >=0.16.21`.
The app owns the records and the merge policy. Import is all-or-nothing and does
not delete data when the capability is installed or removed. See
[backup and file export](https://github.com/freeappstore-online/platform/blob/main/docs/sdk.md#backup-and-file-export-freeappstoresdkbackup).

## Installation

```bash
npm i @freeappstore/sdk
```

## Usage

```ts
import { initApp } from '@freeappstore/sdk';

const fas = initApp({ appId: 'my-app' });

// Capture the OAuth callback if we're returning from sign-in. Call this once
// at app start, before any UI that depends on auth state.
await fas.auth.init();

// React to sign-in / sign-out.
fas.auth.onChange((user) => {
  console.log(user ? `Hello @${user.login}` : 'signed out');
});

// Trigger sign-in (redirects to GitHub).
document.querySelector('#signin')?.addEventListener('click', () => {
  fas.auth.signIn();
});
```

## Modules

### Auth

GitHub OAuth via redirect. Session persists in `localStorage`.

```ts
fas.auth.user;             // User | null
fas.auth.token;            // string | null
fas.auth.signIn();         // redirects to GitHub
fas.auth.signOut();        // clears local session
fas.auth.onChange(cb);     // fires immediately + on change, returns Unsubscribe
await fas.auth.init();     // capture callback, must be called once
```

### Data access contract

| Model | Service | Guarantee |
| --- | --- | --- |
| Device-local | `@freeappstore/sdk/persist` | This browser profile and origin only; not account sync. |
| Private per-account | `fas.kv` | Server-side `(appId, userId)` isolation; authentication required. |
| Public shared | `fas.collections` | Public reads, owner-only writes. Visibility is public even when a query filters by owner. |
| Room-restricted | Backend data-room HTTP API | Authenticated endpoints enforce room membership. They are separate from public collections and realtime room broadcasts; the SDK does not yet provide a wrapper. See the [data-room API](../../docs/data-rooms.md). |

`fas.collections.collection(name, { visibility: 'public-read' })` makes the current visibility explicit in code. Other visibility claims are rejected by the SDK type and runtime.

### Per-user KV

Private per-account cloud storage scoped to `(appId, userId)` server-side. Use it for data that follows a signed-in user across devices. Requests require the account; do not gate unrelated public screens behind sign-in.

```ts
await fas.kv.set('theme', { color: 'plum' });
const theme = await fas.kv.get<{ color: string }>('theme');
await fas.kv.delete('theme');

const allKeys = await fas.kv.list();
const noteKeys = await fas.kv.list({ prefix: 'note:' });
const notes = await fas.kv.getMany<Note>(noteKeys);

// All methods accept { signal } for AbortController cleanup
const ctrl = new AbortController();
await fas.kv.get('key', { signal: ctrl.signal });
```

Limits (server-enforced): max 1MB per user, max 100 keys per user, max 64KB per value.

### Shared counters

App-wide atomic counters — not user-scoped. Anyone can read; authenticated users can increment. Use for vote tallies, view counts, leaderboards.

```ts
// Read (no auth required)
const all = await fas.counters.list();           // { likes: 5, views: 100 }
const views = await fas.counters.get('views');   // 100

// Increment (auth required)
const newVal = await fas.counters.increment('likes');      // +1, returns new value
const newVal2 = await fas.counters.increment('score', 10); // +10
await fas.counters.increment('lives', -1);                 // decrement
```

Limits: max 1000 counters per app, increment range -1000 to +1000 per call.

### Realtime rooms

Durable-Object-backed WebSocket fan-out. Ephemeral — messages are not persisted. Sized for cursor presence, light collab, and Slither-style multiplayer (low state, high frequency).

```ts
const room = fas.rooms.join('lobby');

room.onPeers((peers) => console.log('peers:', peers));
room.onMessage<{ text: string }>((msg) => {
  console.log(msg.from, msg.data.text);
});

room.send({ text: 'hello' });
// later:
room.close();
```

Rooms provide ephemeral realtime broadcast, not durable storage or a room-membership access-control list. Do not use them to claim private-room confidentiality. Limits (server-enforced): 32 peers per room, 100 msgs/sec per peer, 4KB per message, 24h idle eviction, 64 active rooms per app.

### Collections (document database)

Public-read document store for queryable shared data. Anyone can read documents; authenticated owners can write their own. An `owner` query filter is not a privacy boundary. No SQL required — just JSON in, JSON out.

```ts
const posts = fas.collections.collection('posts', { visibility: 'public-read' });

// Create (auth required, you become the owner)
const post = await posts.create({ title: 'Hello', body: '...' });

// Query (public read)
const { documents, total } = await posts.query({
  limit: 20,
  orderBy: 'created_at',
  order: 'desc',
  owner: userId,  // optional: filter by creator
});

// Get single document
const doc = await posts.get('doc-id');

// Update (owner only)
await posts.update('doc-id', { title: 'Updated' });

// Delete (owner only)
await posts.delete('doc-id');
```

Limits: 10,000 documents per collection, 64KB per document.

### Free APIs & libraries (no proxy needed)

Many useful tools require no API key. Use them directly: Leaflet (maps), Recharts (charts), Tiptap (rich text), date-fns, react-markdown, qrcode.react, dnd-kit (drag & drop), Framer Motion, Lucide React (icons), React Hook Form, Zustand. Free APIs: Open-Meteo (weather), Nominatim (geocoding), OSRM (routing), REST Countries, and more. See [SKILLS.md](https://freeappstore.online/skills.md) for the full list.

### Secret-injecting proxy

For APIs that DO need a key, the proxy encrypts and injects it server-side.

```ts
const res = await fas.proxy.fetch('api.openweathermap.org/data/2.5/weather?q=London');
const data = await res.json();
```

### User API Key Vault

Users store their own API keys on the platform (encrypted AES-256-GCM). Apps never see plaintext keys.

```ts
// Check if user has a key configured
const hasKey = await fas.keys.has('openai');

// Redirect to platform key management page
fas.keys.manage('openai');

// Check all configured providers
const keys = await fas.keys.status();
```

Supported providers: OpenAI, Anthropic, Google AI, OpenRouter, Replicate, Stability AI, ElevenLabs, Stripe.

### Push reminders (`fas.push`)

Scheduled Web Push notifications for the signed-in user. The platform sends a push to each of the user's devices for your app when a reminder comes due (checked every 15 minutes).

```ts
const { supported, reason } = fas.push.isSupported();
// reason 'requires-home-screen': on iPhone/iPad, add the app to the Home Screen first

// From a button tap (browsers block permission prompts outside a user gesture):
await fas.push.subscribe(); // asks permission, registers this device

await fas.push.schedule('period-due', { at: new Date('2026-11-02T09:00') });
await fas.push.schedule('log', { daily: '21:00' }, { quietHours: { start: '22:00', end: '07:00' } });
await fas.push.schedule('refill', { everyDays: 28, at: '09:00' }, { tz: 'Europe/London' });

const reminders = await fas.push.list(); // [{ reminderId, when, tz, quietHours, nextAt }]
await fas.push.cancel('log');
await fas.push.unsubscribe(); // this device only
```

Errors: `PushNotSignedInError`, `PushNotSupportedError` (with `reason`), `PushPermissionDeniedError`, `PushNotConfiguredError`.

Pushes carry **no payload**: your service worker shows the notification text, so nothing about the reminder passes through the browser's push service. With vite-plugin-pwa's `injectManifest` strategy, add this to your service worker:

```ts
import { registerFasPushHandler } from '@freeappstore/sdk/push-sw';
registerFasPushHandler({ title: 'Cycle', body: 'Time to check in.', onClick: () => '/' });
```

Keep the text generic for anything sensitive; it can show on a lock screen. Limits: 10 devices and 20 reminders per user per app.

### React Hooks

Import from `@freeappstore/sdk/hooks`. Requires React 18+ as a peer dependency.

```tsx
import { useAuth, useTheme } from '@freeappstore/sdk/hooks';

function App() {
  const { user, loading, signIn, signOut, deleteAccount } = useAuth(fas);
  const { theme, preference, setPreference } = useTheme();
  // ...
}
```

### App shell

Every app wraps itself in `Shell` from `@freeappstore/sdk/ui`: the topbar (app name, text size, theme, avatar link to a profile page), the app's main navigation from `nav`, and an error boundary, loading fallback, toast region, offline banner and skip link around your screens. The avatar opens `/profile` in both auth states: GitHub and Google sign-in choices when signed out, account and preferences when signed in. Pass `profileHref` for an app-owned profile route. The optional sign-in gate (`requireAuth`) protects app content while keeping the profile page accessible.

```tsx
import { type NavItem, PageHeader, Shell, useToast } from '@freeappstore/sdk/ui';

const NAV: NavItem[] = [
  { label: 'Notes', href: '/', title: 'Notes' },
  { label: 'Tags', href: '/tags', title: 'Tags — Notes' },
];

<Shell app={fas} appName="Notes" nav={NAV} onNavigate={navigate}>
  <Screen />
</Shell>

// In a screen: its single h1, and feedback through the shell
<PageHeader title="Tags" />
const toast = useToast(); toast.show('Saved', { variant: 'success' });
```

`onNavigate` makes nav clicks client-side (scroll and focus are handled on route changes); without it the items are ordinary links. `FasShell` is the same component under its older name. Full reference: [docs/ui.md](../../docs/ui.md#shell-the-standard-app-frame).

Omit `profileHref` and the avatar opens the built-in `/profile` page (`ProfilePage`) in both auth states. Set `profileHref` for an app-owned route and render both states yourself. `headerActions` is the header control slot. A custom frame uses `ToastProvider`, `AccountSection`, and the router helpers instead of patching the Shell DOM. `ProfileMenu` is a legacy dropdown. `Shell` does not mount it. Layout ownership: [composable starter contract](../../docs/composable-starter-contract.md). Migration: [Migrating from DOM overrides](../../docs/ui.md#migrating-from-dom-overrides).

### UI Components

Drop-in React components. Import from `@freeappstore/sdk/ui`. Components use CSS custom properties (`--ink`, `--accent`, etc.) to blend into your app's theme.

```tsx
import {
  Shell, PageHeader, NavBar, useToast, useDocumentTitle, useOnline,
  Avatar, SignInButton, ThemeToggle, ProfileMenu, ProfilePage,
  Spinner, Badge, Card, Tabs, Modal, ConfirmDialog, EmptyState,
  ProgressBar, SearchInput, ListRow, ErrorBoundary, KeyPrompt,
} from '@freeappstore/sdk/ui';

// Building blocks
<Spinner size={24} />
<Badge variant="success">Live</Badge>
<Card onClick={fn}>content</Card>
<Tabs tabs={[{key:'a',label:'A'}]} active="a" onChange={setTab} />
<Modal open={show} onClose={close} title="Settings">content</Modal>
<ConfirmDialog open={show} onConfirm={ok} onCancel={cancel} title="Delete?" message="Sure?" variant="danger" />
<EmptyState message="Nothing here yet" />
<ProgressBar value={75} label="Progress" />
<SearchInput value={q} onChange={setQ} />
<ListRow title="Item" subtitle="details" onClick={fn} />
<ErrorBoundary>{children}</ErrorBoundary>
<KeyPrompt app={fas} provider="openai" providerName="OpenAI" />
```

Full docs: [freeappstore.online/skills.md](https://freeappstore.online/skills.md)

## For AI Agents

Building with Claude Code, Cursor, or another AI tool? Two options:

**MCP Server (recommended)** -- your agent gets tools to check deploys, look up SDK docs, and list apps:
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

**SKILLS.md** -- full platform guide (tech stack, SDK reference, CLI, deploy flow, compliance):
```
https://freeappstore.online/skills.md
```

## License

MIT.

## Tailwind styling (SDK 0.16+)

React UI requires Tailwind 4. SDK styles are compiled by your app; they are no
longer injected at runtime. In `web/src/index.css`, after the Tailwind import, add:

```css
@source "../node_modules/@freeappstore/sdk/dist";
@source "../../node_modules/@freeappstore/sdk/dist";
```

Paths are relative to the stylesheet and cover web-local and root-hoisted installs.
Also add the token `@theme inline` mapping and animation keyframes from
[the styling guide](https://github.com/freeappstore-online/platform/blob/main/docs/ui.md#styling).
Both official templates include the complete setup. Floating UI uses opaque
`--popover` (default `var(--paper)`); `--panel` is opaque and glass is opt-in.


The connected draft hook and example are a supported SDK recipe. The canonical generated connected template is not wired to this feature in #350; carry starter wiring and adoption into #352 rather than claiming existing generated templates changed.
