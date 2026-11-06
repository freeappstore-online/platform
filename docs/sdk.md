# SDK Reference

`@freeappstore/sdk` -- browser SDK for apps on freeappstore.online.

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
await fas.auth.deleteAccount();         // deletes the signed-in account and associated active data
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

## Device-local persistence (`@freeappstore/sdk/persist`)

This data stays on this origin on this device. Clearing site data removes it. It is not a backup and it is not the signed-in account.

| Class | API | Where it lives |
| --- | --- | --- |
| Device-local | `@freeappstore/sdk/persist` | This browser profile only |
| Private account | `fas.kv` | The signed-in user's keys on the server |
| Public shared | `fas.collections` | Public read, owner writes |
| Room fan-out | `fas.rooms` | Ephemeral broadcast, not an access list |

A save reports `{ ok: true, value }` only after `localStorage` accepts the write or the IndexedDB transaction commits. Do not show a success toast before that. `{ ok: false, reason }` is `unavailable` (storage blocked), `corrupt` (unreadable bytes, left in place), `quota`, `validation`, `aborted`, `conflict`, or `not-installed`. Nothing in this module deletes corrupt data or resets it to a default.

`watchPreference` fires when a namespaced key changes. That event is a notification, not a merge and not conflict resolution. Read the key and apply an app-owned policy if two tabs disagree. File overwrites use `resolveConflict` on `putFile`; without that function an existing file id is left untouched and the save reports `conflict`. A resolver must preserve the incoming file id; changing it returns `validation` before either metadata or payload is written. Returning null reports `conflict`; a throwing resolver reports `validation` and preserves the stored file.

Preference keys are `fas:<namespace>:<key>`. IndexedDB database names start with `fas:`.

```ts
import {
  getPreference,
  setPreference,
  watchPreference,
  openStore,
  putRecord,
  openFileStore,
  putFile,
} from '@freeappstore/sdk/persist';

const isDraft = (value: unknown): value is { text: string } =>
  typeof value === 'object' && value !== null && 'text' in value &&
  typeof value.text === 'string';

const saved = setPreference('notes', 'draft', { text: 'hello' }, isDraft);
if (!saved.ok) {
  // saved.reason — do not tell the user the draft was saved
}

watchPreference('notes', 'draft', (notice) => {
  // notice.notification === 'storage-changed'
  // Not a merged document. Call getPreference and decide in app code.
  void notice;
});
```

`openStore` runs the caller's versioned `upgrade` and preserves records already in the `records` store. `openFileStore` keeps file metadata and file bytes in separate object stores so listing files does not read the payloads.

## Backup and file export (`@freeappstore/sdk/backup`)

Requires `@freeappstore/sdk >=0.16.21`. This is an optional copy of app-owned device-local data. A backup file is not `fas.kv` and it is not written until the app imports it. The app supplies the schema, the migration, and the merge policy.

`previewBackup` checks the versioned envelope, the SHA-256 checksum, and the size limit, then returns counts. It does not write. `importBackup` requires an explicit `merge` or `replace` choice. There is no default. The import snapshots current data, applies the app's policy, and restores that snapshot if the write throws or the user cancels during the write. Success is returned only after apply finishes. If restore also throws, the result is `{ ok: false, reason: 'rollback' }` and the detail says the stored data may be partial.

`shareOrDownloadBackup` uses `navigator.share` when `canShare` accepts the file. Otherwise it downloads through an object URL and revokes that URL. When neither API exists it returns the JSON text. `mountBackupExample` is an accessible preview: import stays disabled until the user has a preview and has chosen merge or replace. Registering the `backup` capability, or removing the screen, does not delete saved data.

```ts
import {
  exportBackup,
  previewBackup,
  importBackup,
  shareOrDownloadBackup,
  registerBackupCapability,
} from '@freeappstore/sdk/backup';

registerBackupCapability();
const envelope = await exportBackup({ appId: 'notes', data: { notes: ['hello'] } });
```

The default envelope limit is 4 MiB and the hard cap is 16 MiB.

`exportBackup` takes a detached JSON snapshot before asynchronous checksum work.
Its envelope data is typed as `JsonSerialized<T>`: valid Dates become ISO strings,
custom `toJSON()` hooks supply the serialized shape, and nested objects and arrays
are copied without prototypes or methods. Undefined, function, and symbol object
properties are omitted; array entries with those values become null. Non-finite
numbers become null. Cycles and unsupported values such as BigInt fail validation.
The utility describes declared JSON shapes; TypeScript cannot identify whether an
arbitrary property is enumerable or a Date is invalid. Validate untrusted data with
an app-owned schema. The SDK does not automatically restore Dates or class instances;
the app owns schema validation, version migrations, and restoration of domain types.

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

## Collections (`fas.collections`)

Simple document store for public-read, queryable data. Select visibility explicitly with `fas.collections.collection(name, { visibility: 'public-read' })`; public collections cannot represent private rooms or hidden votes.

```ts
const posts = fas.collections.collection('posts', { visibility: 'public-read' });

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

**Limits:** 32 peers/room, 100 msgs/sec/peer, 4KB/message, 64 active rooms/app (a new room past that gets `429`), 24h idle eviction. Room ids: 1–64 characters of letters, digits and `. _ ~ : @ -`.

For component cleanup, unsubscribe listeners and call `room.close()`; closing is
permanent and cancels reconnect. Rejoin after sign-in or account changes because
the connected identity is captured when the room opens. Rooms are ephemeral
broadcast, not private membership or file transport. See the optional realtime
capability recipe from `fas add realtime` for an abort-bound adapter.

## Optional browser media (`@freeappstore/sdk/media`)

This separate entry point is not part of the root SDK bundle. Install the optional
`media` capability for generated wiring and integration guidance. Call
`requestCapture()` only from a user action; handle denial and unsupported APIs,
and pass an `AbortSignal` so a late permission grant has its tracks stopped.
`stopRecording(recorder, stream)` waits for the recorder's final event and then
stops every track. Choose a browser-supported recording type at runtime, and
register a removable PWA busy guard for recording or unsaved media. `exportRecording`
uses file sharing where supported and otherwise offers a download with a releasable
object URL. Display/tab capture is not consistently supported on mobile browsers.
No permission is requested until the app calls capture, and no media is stored by
the SDK.

## Secret-injecting proxy (`fas.proxy`)

Call third-party APIs without exposing keys to the browser.

```ts
const res = await fas.proxy.fetch('api.openweathermap.org/data/2.5/weather?q=London');
const data = await res.json();
```

The developer registers secrets and allowlist rules via the CLI. The proxy decrypts and injects the key server-side. See [Proxy & Keys](proxy-and-keys.md).

## User API key vault (`fas.keys`)

Users store their own API keys on the platform (encrypted AES-256-GCM). Keys are injected by `fas.proxy.fetch()` when the upstream host matches a supported provider; the requesting app does not receive the plaintext key.

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
await fas.friends.remove(userId);              // unfriend, cancel outgoing request, or unblock
const status = await fas.friends.check(userId);
const isFriend = await fas.friends.isFriend(userId);
const matches = await fas.friends.search('alice');
```

## Email (`fas.email`)

Send transactional email via Cloudflare Email Service. 100/day per app, 50/day per sender and a platform-wide daily cap; requires sign-in and a configured sending service. The app owner can send to any recipient; any other signed-in user must have a role in the app and can only send to their own verified address (so an app can mail its users, but a user can't relay through it).

```ts
await fas.email.send('user@example.com', 'Welcome', {
  html: '<p>Hello!</p>',
});
```

## Push reminders (`fas.push`)

Scheduled Web Push notifications for the signed-in user. Register a device with `subscribe()`, then set reminders; the platform's cron sends a push to every device the user subscribed for your app when one comes due (every 15 minutes, so up to ~15 min late).

```ts
fas.push.isSupported();   // { supported, reason: 'ok' | 'requires-home-screen' | 'browser-unsupported' }
fas.push.permission();    // 'default' | 'granted' | 'denied'

await fas.push.subscribe();    // from a user gesture: asks permission, registers this device
await fas.push.unsubscribe();  // this device only

// One-shot, daily, or every N days; times are HH:MM in `tz` (default: the device's zone)
await fas.push.schedule('period-due', { at: new Date('2026-11-02T09:00') });
await fas.push.schedule('log', { daily: '21:00' }, { quietHours: { start: '22:00', end: '07:00' } });
await fas.push.schedule('refill', { everyDays: 28, at: '09:00' }, { tz: 'Europe/London' });
await fas.push.list();         // [{ reminderId, when, tz, quietHours, nextAt }]
await fas.push.cancel('log');
```

- **iPhone and iPad:** web push only works once the app is added to the Home Screen and opened from there (`reason: 'requires-home-screen'`).
- **Errors:** `PushNotSignedInError`, `PushNotSupportedError` (`.reason`), `PushPermissionDeniedError`, `PushNotConfiguredError` (the platform's push key isn't set).
- **Repeats** keep their local time across daylight-saving changes. A reminder due in quiet hours is held until the window ends.
- **No payload:** your service worker decides what the notification says, so nothing about the reminder passes through the browser's push service. With vite-plugin-pwa `injectManifest`:

```ts
// src/sw.ts
import { registerFasPushHandler } from '@freeappstore/sdk/push-sw';
registerFasPushHandler({ title: 'Cycle', body: 'Time to check in.', onClick: () => '/' });
```

It shows the notification on each push and focuses (or opens) the app when tapped. Keep the text generic for anything sensitive; it can show on a lock screen.

**Limits:** 10 devices and 20 reminders per user per app. See [Platform Limits](platform-limits.md#push-subscriptions-faspush).

## Webhooks (`fas.webhooks`)

Outbound webhook subscriptions. HMAC-SHA256 signed.

```ts
const { webhooks, supported_events } = await fas.webhooks.list();
const { id, secret } = await fas.webhooks.create('kv.changed', 'https://example.com/hook');
const result = await fas.webhooks.test(id);
await fas.webhooks.delete(id);
```

**Limits:** 5 webhooks per app, 12 event types. Management requires app ownership. Read `supported_events` from `list()` rather than inventing event names.

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

## App shell

The standard app frame, `Shell`, and the screen helpers (`PageHeader`, `useToast`,
`useDocumentTitle`, `useOnline`) live in `@freeappstore/sdk/ui`. See
[UI Components: Shell](ui.md#shell-the-standard-app-frame).

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

Record and file operations resolve transaction-start failures through `StorageResult`, including `unavailable` after explicit close or automatic close when another tab upgrades the database. Existing data remains intact; the app owns reopening the handle. Record validators should return a boolean: false reports `validation`, while a thrown validator error rejects the API promise. A throwing or rejecting `withTransaction` callback aborts its writes and resolves a classified storage failure.


## Connected data example

For race-safe private per-account editing, see the [connected data example](https://github.com/freeappstore-online/platform/tree/main/examples/connected-data) and `useConnectedKvDraft` from `@freeappstore/sdk/hooks`. It guards initial loading, preserves dirty edits, supports retry/save status, and isolates requests on app, record, account, and sign-out changes. Gate only the private-data feature; leave public browsing available. If an app owns its profile route, render `AccountSection` so GitHub and Google choices remain available.

#350 ships the SDK hook and standalone example. The canonical generated connected template remains unchanged; carry its wiring and adoption into #352. Planning Poker's app-owned remediation is tracked in [Planning Poker #1](https://github.com/freeappstore-online/planning-poker/issues/1). No room or user data was read or changed.

Durable room-restricted records use the backend's authenticated data-room endpoints documented in [data rooms](https://github.com/freeappstore-online/platform/blob/main/docs/data-rooms.md); the SDK does not yet wrap those endpoints. These private endpoints are separate from public collections and realtime room broadcasts. Membership is enforced by the backend for each request.
