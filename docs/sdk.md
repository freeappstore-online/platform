# SDK Reference

`@freeappstore/sdk` -- browser SDK for apps on freeappstore.online.

```bash
npm i @freeappstore/sdk
```

**App data stays on the device.** FAS stores no application data on the server ([ADR-004](https://github.com/freeappstore-online/platform/blob/main/docs/adr/004-no-server-app-data.md)): the backend relays, identifies and holds metadata and keys, never app content. Keep an app's data with [device-local persistence](#device-local-persistence-freeappstoresdkpersist) and [backups](#backup-and-file-export-freeappstoresdkbackup). Anything multi-user or server-backed belongs on [ProAppStore](https://proappstore.online). `fas.kv`, `fas.collections`, data rooms and photo uploads are **deprecated for app data**; their sections below remain only for apps that already use them.

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
fas.auth.signOut();                     // signs out of this app ("sign out everywhere" lives in the console)
await fas.auth.deleteAccount();         // opens the console's account settings — deletion needs a first-party session
fas.auth.onChange(cb);                  // fires immediately + on change, returns Unsubscribe
fas.auth.setDateOfBirth('2000-01-15'); // set user date of birth
await fas.auth.init();                  // capture callback, must be called once
```

Providers: `'github' | 'google' | 'apple' | 'email'`.

A magic link opened in the browser that asked for it signs in directly. Opened anywhere else (another browser or device, or an app on a domain outside `freeappstore.online`, where the binding cookie can't be set), it first shows a "Continue signing in as alice@example.com to this app?" page on the API origin; the link stays single-use and expires after 15 minutes.

## Per-user KV (`fas.kv`)

> **Deprecated for app data ([ADR-004](https://github.com/freeappstore-online/platform/blob/main/docs/adr/004-no-server-app-data.md)).** Kept for existing apps only; do not use it in new code. Use [device-local persistence](#device-local-persistence-freeappstoresdkpersist).

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
| Private account (deprecated, ADR-004) | `fas.kv` | The signed-in user's keys on the server. Existing apps only |
| Shared documents (deprecated, ADR-004) | `fas.collections` | Server documents, owner-only unless the app owner shares the collection. Existing apps only; multi-user data belongs on ProAppStore |
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

App-wide atomic counters. Anyone can read; authenticated users can increment. Decrementing (a negative amount) is reserved for the app owner and users holding a privileged app role (anything other than `member` / `viewer`), so a signed-in stranger can't zero your likes or votes.

```ts
const all = await fas.counters.list();           // { likes: 5, views: 100 }
const views = await fas.counters.get('views');   // 100
const newVal = await fas.counters.increment('likes');      // +1
const newVal2 = await fas.counters.increment('score', 10); // +10
await fas.counters.increment('lives', -1);                 // decrement — owner / privileged role only (403 otherwise)
```

**Limits:** 1000 counters per app, increment range -1000 to +1000 per call.

## Collections (`fas.collections`)

> **Deprecated for app data ([ADR-004](https://github.com/freeappstore-online/platform/blob/main/docs/adr/004-no-server-app-data.md)).** Kept for existing apps only; do not use it in new code. Multi-user or server-backed data belongs on [ProAppStore](https://proappstore.online).

Simple document store for queryable data. **A collection is private to the user who wrote each document by default**: a read lists and returns only your own documents, a signed-out read gets 401, another user's document id answers 404, and `owner` can only be your own id (anything else is 403). `_owner` is shown only on your own documents.

A collection that other users must read (a public feed, a shared playlist, a poll) has to be marked shared by the app owner, once: `fas db share posts`. Declare it in code with `{ visibility: 'public-read' }` (default `'private'`). A shared collection is readable by anyone, signed in or not, and still cannot represent private rooms or hidden votes. Writes are owner-only either way. `fas db unshare posts` makes it private again; `fas db list` shows what is shared.

```ts
const posts = fas.collections.collection('posts', { visibility: 'public-read' }); // after `fas db share posts`

// Create (auth required, you become the owner)
const post = await posts.create({ title: 'Hello', body: '...' });

// Query (your own documents, or everyone's once shared)
const { documents, total } = await posts.query({
  limit: 20,
  orderBy: 'created_at',
  order: 'desc',
  owner: userId, // only ever your own id
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

Room properties: `room.state`, `room.peers`, `room.isReconnecting`, `room.reconnectAttempts`, `room.denied`.

Rooms are open to any signed-in user by default. `fas.rooms.join('staff', { private: true })` marks a room private: from then on only users who hold an app role for this app (the app's owner, or anyone the owner granted a role with the roles API; the `member` role every user gets automatically does not count) can join it, and only such a user can make a room private. Everyone else gets `room.denied === true` (state `error`, no retry). `{ private: false }` opens a private room again. Private rooms gate who can join; messages are still ephemeral broadcast, not stored.

**Limits:** 32 peers/room, 100 msgs/sec/peer, 4KB/message, 64 active rooms/app (a new room past that gets `429`), 24h idle eviction. Room ids: 1–64 characters of letters, digits and `. _ ~ : @ -`.

For component cleanup, unsubscribe listeners and call `room.close()`; closing is
permanent and cancels reconnect. Rejoin after sign-in or account changes because
the connected identity is captured when the room opens. Rooms are ephemeral
broadcast (private rooms gate who joins, nothing more), not file transport. See the optional realtime
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

## Local AI bridge (`@freeappstore/sdk/bridge`)

A separate entry point, not part of the root bundle. `exposeTools({ tools, enabled, appId, onStatus })` offers
tools (`{ name, description, inputSchema, handler }`) to a local AI client through the FreeAppStore desktop app,
over the desktop window's IPC channel or `ws://127.0.0.1:47821/bridge` from a browser tab. It returns
`{ status, setEnabled, close }`. See [MCP: local AI access](mcp.md#local-ai-access-to-app-data-freeappstore-desktop).

## Secret-injecting proxy (`fas.proxy`)

Call third-party APIs without exposing keys to the browser.

```ts
const res = await fas.proxy.fetch('api.openweathermap.org/data/2.5/weather?q=London');
const data = await res.json();
```

The developer registers secrets and allowlist rules via the CLI (`fas proxy allow`). A host with no rule for the app is refused. The proxy decrypts and injects the key server-side. See [Proxy & Keys](proxy-and-keys.md).

## User API key vault (`fas.keys`)

Users store their own API keys on the platform (encrypted AES-256-GCM). Keys are injected by `fas.proxy.fetch()` when the upstream host is a supported provider that the app has declared with `fas proxy allow --user-key`; the requesting app does not receive the plaintext key.

```ts
const hasKey = await fas.keys.has('openai');
fas.keys.manage('openai');          // redirect to key management page
const keys = await fas.keys.status(); // check all configured providers
```

Supported providers: OpenAI, Anthropic, Google AI, OpenRouter, Replicate, Stability AI, ElevenLabs.

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

Outbound webhook subscriptions. HMAC-SHA256 signed. Register a webhook (and get its signing
secret) in the Creator Console under your app's **Webhooks**; the API refuses registration from an
app session. From the app, the owner can list, test and delete them:

```ts
const { webhooks, supported_events } = await fas.webhooks.list();
const { status } = await fas.webhooks.test(webhooks[0].id); // the receiver's HTTP status
await fas.webhooks.delete(webhooks[0].id);
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

While signed in, entries upload in batches every 30 seconds. A batch the server rejects outright
(for example 400 or 404) is skipped so it can't hold up later entries; after the daily cap (429)
uploads pause until midnight UTC; other failures retry on the next tick.

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

> **Deprecated ([ADR-004](https://github.com/freeappstore-online/platform/blob/main/docs/adr/004-no-server-app-data.md)).** This example syncs a draft through `fas.kv`. New apps keep drafts on the device with `@freeappstore/sdk/persist`.

For race-safe private per-account editing, see the `ConnectedDraft` component that `fas init <app-id> --template connected` generates (`web/src/components/ConnectedDraft.tsx`; the MCP `sdk_reference` feature `connected-data` returns the same component) and `useConnectedKvDraft` from `@freeappstore/sdk/hooks`. It guards initial loading, preserves dirty edits, supports retry/save status, and isolates requests on app, record, account, and sign-out changes. Gate only the private-data feature; leave public browsing available. If an app owns its profile route, render `AccountSection` so GitHub and Google choices remain available.

#350 ships the SDK hook and standalone example. The canonical generated connected template remains unchanged; carry its wiring and adoption into #352. Planning Poker's app-owned remediation is tracked in [Planning Poker #1](https://github.com/freeappstore-online/planning-poker/issues/1). No room or user data was read or changed.

Data rooms are deprecated for app data (ADR-004); they remain only for existing apps. Durable room-restricted records use the backend's authenticated data-room endpoints documented in [data rooms](https://github.com/freeappstore-online/platform/blob/main/docs/data-rooms.md); the SDK does not yet wrap those endpoints. These private endpoints are separate from public collections and realtime room broadcasts. Membership is enforced by the backend for each request.

## Phone companion locations (`fas.native`)

The FreeAppStore phone app (iOS, [native companion](native-companion.md)) keeps recording location with the phone locked and shares it with apps the user turns on. Only reviewed apps can receive it (today: Run), only for the signed-in user, and only through that app's own session. Points are kept for 7 days.

```ts
const s = await fas.native.status();   // { available, enabled, lastPointAt }
if (s.available && !s.enabled) location.href = fas.native.setupUrl; // freeappstore://native/apps/<appId>

// Everything recorded since the activity started (paged, recording order):
let cursor = { after: startedAt, afterId: '' };
let more = true;
while (more) {
  const page = await fas.native.locations(cursor);  // up to 500 per call
  for (const p of page.points) addPoint(p);          // { id, at, lat, lng, accuracy }
  ({ cursor, more } = page);
}
```

The cursor orders by recording time, not arrival. The phone uploads when it has signal, so a point can land behind a cursor you already read past: to cover a time window, re-read it from its start and dedupe by `id`. Other apps get `available: false`; a console or other-app session gets 403.

## Temporary photos

> **Deprecated for app data ([ADR-004](https://github.com/freeappstore-online/platform/blob/main/docs/adr/004-no-server-app-data.md)).** Kept for existing apps only. New apps keep photos on the device (`openFileStore` / `putFile`).

Use `fas.photos.upload(file)` for private photos, or explicitly pass
`{ visibility: 'public' }` for listing photos. The SDK resizes and compresses;
the API enforces 640 px, 200,000 bytes, quotas and 90-day expiry.
See [Photo uploads](photo-uploads.md) for the contract and examples.

## Community generation (`fas.generation`)

Devices of signed-in users generate pregenerated assets (today: TTS narration) with a local model and contribute them for everyone. The server never trusts the device: the owner decides what is generated, every upload is verified in private quarantine before it is public, and the first accepted result is stored write-once. The SDK bundles no model; the app supplies `generate`.

```ts
// Owner (app owner session; CI can call the same API with GitHub Actions OIDC)
const set = await fas.generation.createSet({
  kind: 'tts', model: 'kokoro', modelVersion: 'v1.0', params: { voice: 'af_heart' },
  formats: ['audio/mp4'], maxBytes: 5_000_000, replicas: 1,
  language: 'en', // optional BCP 47 tag; 'zh' for Mandarin
});
await fas.generation.addJobs(set.id, [{ key: 'ch1:p1', input: { text: 'Call me Ishmael.' } }]); // 1-500; same key + different input → 409
await fas.generation.withdraw(jobId);           // the job reopens
await fas.generation.blockContributor(userId);  // withdraws everything they contributed
const sets = await fas.generation.listSets();   // [{ ...set, createdAt, counts: { jobs, open, accepted, leased, pending, rejected, withdrawn } }]
const { jobs, nextCursor } = await fas.generation.listJobs(set.id, { status: 'accepted', cursor, limit: 50 });
// jobs: [{ id, key, status, inputPreview, inputChars, createdAt, artifact: { url, durationMs, bytes, contributor, acceptedAt } | null, submissions }]
const job = await fas.generation.getJob(set.id, jobId); // one job as listed, plus its whole input: { ..., input: { text } }

// Contributor: claim → generate → submit until there is no work
const controller = new AbortController();
const { submitted, stopped } = await fas.generation.contribute({
  setId: set.id,
  models: [{ model: 'kokoro', modelVersion: 'v1.0' }],
  generate: async (job) => ({ file: await synthesize(job.input.text, job.params), meta: { timings } }),
  signal: controller.signal,
  onProgress: ({ stage, job, submitted }) => console.log(stage, job.key, submitted),
}); // stopped: 'no-work' | 'aborted' | 'lease-expired'
const mine = await fas.generation.mySubmissions(); // newest 100: [{ submissionId, jobId, setId, key, status, reason, bytes, contentType, createdAt, decidedAt, wer, durationMs, input: { text }, artifact: { url, metaUrl } | null }]
await fas.generation.recordAttempts([{ jobId, runner: 'browser', reason: 'submitted', wallMs, synthMs }]); // attempt records (#827): numbers only, one per lease; owners see them in listJobs
const work = await fas.generation.openWork();      // this app's sets the user could claim now: [{ setId, kind, model, modelVersion, params, formats, maxBytes, language, open }]

// Public, no sign-in: accepted artifacts with absolute URLs
const artifacts = await fas.generation.manifest(set.id); // [{ key, jobId, url, metaUrl?, bytes, contentType, durationMs, sha256, model, modelVersion, acceptedAt }]
```

Runners exist today only for `kokoro` `v1.0` with `audio/mp4` and params `{ voice, speed? }`: the Android and iOS companions (all Kokoro v1.0 voices, Mandarin included) and the browser runner below (English voices only). A set naming another model is accepted but never claimed; to ask for a model, open an issue on the platform repo. `language` (BCP 47, e.g. `en`, `es`, `zh`; `null` when omitted) is passed to Whisper and picks the default characters-per-second band (`zh` 2-9, `ja` 3-15, others 8-30); Chinese, Japanese, Thai and other scripts without spaces are verified by character error rate, Traditional and Simplified Chinese alike. `minCharsPerSecond`, `maxCharsPerSecond` and `maxWer` (0.25) override the defaults. See [Models and runners](community-generation.md#models-and-runners).

The step-by-step calls are `claim({ setId?, models })` (a 15-minute lease, or `null` when there is no work; it releases this browser's previous lease, while the user's other devices keep theirs, up to 4 open leases per user, then it throws on the `429`) and `submit(job, file, { meta?, attestation? })` (`202`, status `pending`), plus `extendLease(job)`, which pushes `job.leaseExpiresAt` to 15 minutes from now (at most 2 hours after the claim; throws at the cap or once the lease is invalid). Submissions move to `accepted`, `rejected` (with a `reason`) or `superseded`. While `generate` runs, `contribute` extends the lease within 5 minutes of its expiry; a job is abandoned (back to the pool) only if extending fails and the lease runs out before the result is ready.

### Kokoro in the browser (`@freeappstore/sdk/generation-kokoro`)

A ready-made `generate` for TTS sets with `model: 'kokoro'`, `modelVersion: 'v1.0'`, `formats` including `audio/mp4` and `params: { voice, speed? }` (Kokoro's English voices; `kokoroProblem` skips a set naming another `language`, such as `zh`, or using a non-English voice, and says why). Books and the Creator Console's Generate page use it. It runs [kokoro-js](https://www.npmjs.com/package/kokoro-js) in a Web Worker (WebGPU fp32, about 326 MB, else WebAssembly q8, about 92 MB; cached in Cache Storage), speaks the text a sentence at a time (`narrationSentences`, the same split as Books' `segments.py`), encodes AAC with WebCodecs into MP4 ([mp4-muxer](https://www.npmjs.com/package/mp4-muxer)) and submits the sentence timings as meta `{ segments: [[charStart, charEnd, startSec, endSec], …] }`. `kokoro-js` and `mp4-muxer` are optional peer dependencies: install them (`kokoro-js@1.2.1`, `mp4-muxer@5.2.2`) only if you use this. The window must stay open while it runs.

It generates exactly the claimed input with the job's model, version and params, or skips the job (the next claim releases it): another model or version, no `audio/mp4`, params other than `voice` and `speed`, a voice Kokoro doesn't have, audio over `maxBytes`, timings over the 64 KB meta limit, or too slow to finish within the lease's 2-hour cap.

```ts
// kokoro.worker.ts: the app's own worker module, so its bundler builds the model's runtime
import { serveKokoroWorker } from '@freeappstore/sdk/generation-kokoro/worker';
serveKokoroWorker(); // or { wasmPaths } to serve ONNX Runtime's .wasm from the app instead of a CDN

// main thread
import { contributeKokoro, kokoroDevice, kokoroEncoder, kokoroProblem, KokoroRunner,
  KOKORO_DOWNLOAD_BYTES, isKokoroDownloaded, deleteKokoroModel } from '@freeappstore/sdk/generation-kokoro';
const encoder = await kokoroEncoder();  // null: no WebCodecs AAC (e.g. Firefox) — hide the feature
const device = await kokoroDevice();    // 'webgpu' | 'wasm'; show KOKORO_DOWNLOAD_BYTES[device] before the first run
const runner = new KokoroRunner({
  createWorker: () => new Worker(new URL('./kokoro.worker.ts', import.meta.url), { type: 'module' }),
  encoder, device,
});
await runner.load((p) => console.log(p)); // optional: download (unless cached) once the user agreed, with progress 0-1
const sets = (await fas.generation.openWork()).filter((s) => !kokoroProblem(s));
const { submitted, stopped } = await contributeKokoro(fas.generation, {
  runner, setId: sets[0].setId, signal: controller.signal,
  onEvent: (e) => console.log(e), // loading | claimed | progress { sentence, sentences, chars, totalChars, charsPerSecond } | submitted | skipped
}); // stopped: 'no-work' | 'aborted'
runner.dispose();          // frees the model's memory
await deleteKokoroModel(); // frees its storage
```
