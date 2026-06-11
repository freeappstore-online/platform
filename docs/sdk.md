# SDK Reference

`@freeappstore/sdk` v0.14 -- browser SDK for apps on freeappstore.online.

```bash
npm i @freeappstore/sdk
```

## Initialization

```ts
import { initApp } from '@freeappstore/sdk';

const fas = initApp({ appId: 'my-app' });
await fas.auth.init(); // capture OAuth callback — call once at app start
```

## Auth (`fas.auth`)

OAuth via redirect. Supports GitHub, Google, Apple, and Email (magic link). Session persists in `localStorage`.

```ts
fas.auth.user;                          // User | null
fas.auth.token;                         // string | null
fas.auth.signIn();                      // default: GitHub
fas.auth.signIn('google');              // Google OAuth
fas.auth.signIn('apple');               // Apple Sign In
fas.auth.signIn('email');               // prompts for email, sends magic link
fas.auth.signInWithEmail('user@x.com'); // send magic link directly
fas.auth.signOut();                     // clears local session
fas.auth.onChange(cb);                  // fires immediately + on change, returns Unsubscribe
fas.auth.setDateOfBirth('2000-01-15'); // set user date of birth
await fas.auth.init();                  // capture callback, must be called once
```

Providers: `'github' | 'google' | 'apple' | 'email'`.

## Per-user KV (`fas.kv`)

Per-user, per-app key-value store. Scoped to `(appId, userId)` server-side.

```ts
await fas.kv.set('theme', { color: 'plum' });
const theme = await fas.kv.get<{ color: string }>('theme');
await fas.kv.delete('theme');

const allKeys = await fas.kv.list();
const noteKeys = await fas.kv.list({ prefix: 'note:' });
const notes = await fas.kv.getMany<Note>(noteKeys); // bulk fetch
```

**Limits:** 1MB per user, 100 keys, 64KB per value. All methods accept `{ signal }` for AbortController.

## Shared counters (`fas.counters`)

App-wide atomic counters. Anyone can read; authenticated users can increment.

```ts
const all = await fas.counters.list();           // { likes: 5, views: 100 }
const views = await fas.counters.get('views');   // 100
const newVal = await fas.counters.increment('likes');      // +1
const newVal2 = await fas.counters.increment('score', 10); // +10
await fas.counters.increment('lives', -1);                 // decrement
```

**Limits:** 1000 counters per app, increment range -1000 to +1000 per call.

## Collections (`fas.db`)

Simple document store for public, queryable data.

```ts
const posts = fas.db.collection('posts');

// Create (auth required, you become the owner)
const post = await posts.create({ title: 'Hello', body: '...' });

// Query (public read)
const { documents, total } = await posts.query({
  limit: 20,
  orderBy: 'created_at',
  order: 'desc',
  owner: userId,
});

// Get / Update / Delete (owner only for writes)
const doc = await posts.get('doc-id');
await posts.update('doc-id', { title: 'Updated' });
await posts.delete('doc-id');
```

**Limits:** 10,000 documents per collection, 64KB per document.

## Realtime rooms (`fas.rooms`)

Durable-Object-backed WebSocket fan-out. Ephemeral -- messages are not persisted.

```ts
const room = fas.rooms.join('lobby');

room.onPeers((peers) => console.log('peers:', peers));
room.onMessage<{ text: string }>((msg) => {
  console.log(msg.from, msg.data.text);
});
room.onConnectionState((state) => console.log(state));
// state: 'connecting' | 'open' | 'closed' | 'error'

room.send({ text: 'hello' });
room.close();
```

Room properties: `room.state`, `room.peers`, `room.isReconnecting`, `room.reconnectAttempts`.

**Limits:** 32 peers/room, 100 msgs/sec/peer, 4KB/message, 64 rooms/app, 24h idle eviction.

## Secret-injecting proxy (`fas.proxy`)

Call third-party APIs without exposing keys to the browser.

```ts
const res = await fas.proxy.fetch('api.openweathermap.org/data/2.5/weather?q=London');
const data = await res.json();
```

The developer registers secrets and allowlist rules via the CLI. The proxy decrypts and injects the key server-side. See [Proxy & Keys](proxy-and-keys.md).

## User API key vault (`fas.keys`)

Users store their own API keys on the platform (encrypted AES-256-GCM). Apps never see plaintext keys.

```ts
const hasKey = await fas.keys.has('openai');
fas.keys.manage('openai');          // redirect to key management page
const keys = await fas.keys.status(); // check all configured providers
```

Supported providers: OpenAI, Anthropic, Google AI, OpenRouter, Replicate, Stability AI, ElevenLabs, Stripe.

## RBAC roles (`fas.roles`)

Per-app role management. Built-in roles: `owner`, `member`, `moderator`, `editor`, `viewer`. Custom roles supported.

```ts
const roles = await fas.roles.myRoles();             // ['member']
const all = await fas.roles.listAll();               // all role assignments
const mods = await fas.roles.list('moderator');      // users with this role
const isMod = await fas.roles.check('moderator');    // check current user
await fas.roles.assign(userId, 'moderator');         // assign role
await fas.roles.revoke(userId, 'moderator');         // revoke role
```

## Friends (`fas.friends`)

Platform-level friendship system. Friends persist across all apps.

```ts
const friends = await fas.friends.list();                      // accepted friends
const pending = await fas.friends.list('pending_incoming');     // incoming requests
const outgoing = await fas.friends.list('pending_outgoing');    // outgoing requests
const requests = await fas.friends.requests();                 // incoming requests

const result = await fas.friends.request(userId);              // send friend request
// result: { status, autoAccepted }

await fas.friends.respond(userId, 'accept');   // accept request
await fas.friends.respond(userId, 'decline');  // decline request
await fas.friends.respond(userId, 'block');    // block user
```

## Email (`fas.email`)

Send transactional email via Resend. 100/day per app.

```ts
await fas.email.send('user@example.com', 'Welcome', {
  html: '<p>Hello!</p>',
});
```

## Webhooks (`fas.webhooks`)

Outbound webhook subscriptions. HMAC-SHA256 signed.

```ts
const { webhooks, supported_events } = await fas.webhooks.list();
const { id, secret } = await fas.webhooks.create('app.published', 'https://example.com/hook');
const result = await fas.webhooks.test(id);
await fas.webhooks.delete(id);
```

**Limits:** 5 webhooks per app, 8 event types.

## Logging (`fas.log`)

3-layer logging: memory, localStorage, server.

```ts
fas.log.debug('loaded', { count: 5 });
fas.log.info('user signed in');
fas.log.warn('rate limited');
fas.log.error('fetch failed', { url });

const entries = fas.log.entries();
await fas.log.flush();   // send to server
fas.log.clear();
```

## React hooks

Import from `@freeappstore/sdk/hooks`. Requires React 18+.

```tsx
import { useAuth, useTheme, useFriends, useVoiceInput } from '@freeappstore/sdk/hooks';

function App() {
  const { user, loading, signIn, signOut, deleteAccount, hasRole } = useAuth(fas);
  const { theme, preference, setPreference } = useTheme();
  const { friends, requests, loading: friendsLoading, requestCount, refresh } = useFriends(fas);
  const { isListening, start, stop, transcript } = useVoiceInput((text) => console.log(text));
}
```
