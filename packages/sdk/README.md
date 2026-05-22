# @freeappstore/sdk

Browser SDK for free apps published on **freeappstore.online**.

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

### Per-user KV

Per-user, per-app key-value store. Scoped to `(appId, userId)` server-side, so apps cannot read each other's data and users cannot read each other's data.

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

Limits (server-enforced): 32 peers per room, 100 msgs/sec per peer, 4KB per message, 24h idle eviction, 64 active rooms per app.

### Collections (document database)

Simple document store for apps that need public, queryable data. No SQL required — just JSON in, JSON out.

```ts
const posts = fas.db.collection('posts');

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

### Secret-injecting proxy

Call third-party APIs without exposing your keys in the browser. The platform Worker authenticates the call, injects the developer's stored API key server-side, and forwards the request.

```ts
const res = await fas.proxy.fetch('api.openweathermap.org/data/2.5/weather?q=London');
const data = await res.json();
```

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

### UI Components

Drop-in React components. Import from `@freeappstore/sdk/ui`. Components use CSS custom properties (`--ink`, `--accent`, etc.) to blend into your app's theme.

```tsx
import { FasShell, Avatar, SignInButton, ThemeToggle, ProfileMenu, ProfilePage } from '@freeappstore/sdk/ui';

// Zero-config shell
<FasShell app={fas} appName="My App">
  <MyApp />
</FasShell>

// Or use individual components
<Avatar user={user} size={32} />
<ThemeToggle />
<ProfileMenu app={fas} />
<ProfilePage app={fas} />
```

Full docs: [freeappstore.online/docs/ui](https://freeappstore.online/docs/ui)

## License

MIT.
