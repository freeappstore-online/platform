# @freeappstore/sdk

## 0.1.1

- Docs: clearer JSDoc on `auth.init()` with usage example.
- No runtime changes — first release published via the auto-publish CI workflow.

## 0.1.0

- Initial release. Browser SDK with three modules:
  - `auth` — GitHub OAuth via redirect, session persisted in `localStorage`.
  - `kv` — per-user, per-app key-value store. Limits: 1MB/user, 100 keys/user, 64KB/value.
  - `rooms` — Durable-Object-backed WebSocket fan-out with reconnect + connection-state events. Limits: 32 peers/room, 100 msgs/sec/peer, 4KB/msg, 64 active rooms/app, 24h idle TTL.
