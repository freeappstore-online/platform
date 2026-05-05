# @freeappstore/sdk

## 0.1.2

- **Fix:** `auth.init()` no longer leaves the `#fas_session=…` hash on the URL when the auth fetch fails. Previously a bad/expired token meant every reload retried it and the user was stuck.
- **Fix:** `auth.signIn()` strips the page's `location.hash` from `return_to` so apps using hash-based routers don't lose their route across the OAuth bounce.
- **Fix:** `kv.get/set/delete('')` and other invalid keys now throw clearly instead of producing a `404` with no useful message. Keys must be non-empty strings ≤ 128 chars.
- First unit tests for the SDK (auth + kv).

## 0.1.1

- Docs: clearer JSDoc on `auth.init()` with usage example.
- No runtime changes — first release published via the auto-publish CI workflow.

## 0.1.0

- Initial release. Browser SDK with three modules:
  - `auth` — GitHub OAuth via redirect, session persisted in `localStorage`.
  - `kv` — per-user, per-app key-value store. Limits: 1MB/user, 100 keys/user, 64KB/value.
  - `rooms` — Durable-Object-backed WebSocket fan-out with reconnect + connection-state events. Limits: 32 peers/room, 100 msgs/sec/peer, 4KB/msg, 64 active rooms/app, 24h idle TTL.
