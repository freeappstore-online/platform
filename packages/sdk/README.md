# @freeappstore/sdk

Browser SDK for free apps published on **freeappstore.online**.

```bash
npm i @freeappstore/sdk
```

## Quick start

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
fas.auth.onChange(cb);     // returns Unsubscribe
await fas.auth.init();     // capture callback, must be called once
```

### Per-user KV

Per-user, per-app key-value store. Scoped to `(appId, userId)` server-side, so apps cannot read each other's data and users cannot read each other's data.

```ts
await fas.kv.set('theme', { color: 'plum' });
const theme = await fas.kv.get<{ color: string }>('theme');
await fas.kv.delete('theme');
```

Limits (server-enforced): max 1MB per user, max 100 keys per user, max 64KB per value. See [`docs/LIMITS.md`](../../docs/LIMITS.md) for the full list.

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

## What's not in v0

- File uploads / R2 storage
- Push notifications
- Outbound HTTP / AI proxy
- Scheduled tasks / cron
- Email / magic links
- Search

These come in v0.1+ once we know what creators actually ask for. Pro-only modules (Stripe, paid quotas) are explicitly out of scope for `@freeappstore/sdk` — they live in `@proappstore/sdk`.

## License

MIT.
