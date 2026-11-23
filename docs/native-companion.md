# Native companion

The FreeAppStore phone app keeps collecting location with the screen locked and
hands it to the FAS apps you turn on. Decision record: [ADR-002](adr/002-native-companion.md).

## Recipients

| App | Capability | Purpose |
|---|---|---|
| Run | `location.background` | Keep recording runs and walks while the phone is locked or Run is closed. |

The list lives in `packages/backend/src/lib/native-companion.ts`. Each entry's
contract version is a hash of its wording, so any change to the disclosure
revokes every existing grant and users consent again.

## API (base `https://api.freeappstore.online/v1`)

Device side, `Authorization: Bearer ndev_…`:

| Call | Body | Response |
|---|---|---|
| `POST /native/auth/start` | `{ challenge: sha256hex(verifier), label }` | `{ id, authorizationUrl, expiresIn }` |
| `POST /native/auth/complete` | `{ id, verifier }` | `202 { pending }` or `{ token, deviceId }` |
| `GET /native/me` | — | `{ user, device, apps: [{ id, name, purpose, disclosure, version, grant }] }` |
| `PUT /native/apps/:appId/location` | `{ enabled: true, version }` | `{ grant }` |
| `DELETE /native/apps/:appId/location` | — | `{ revoked: true }` |
| `POST /native/locations` | `{ points: [{ id, at, lat, lng, accuracy, grants }] }` (1–100) | `{ acknowledged: [id] }` |
| `DELETE /native/device` | — | `{ disconnected: true }` |

App side, with the app's own session (`aud` = app id):

| Call | Response |
|---|---|
| `GET /apps/:appId/native/status` | `{ available, enabled, lastPointAt }` |
| `GET /apps/:appId/native/locations?after=<ms>&afterId=<cursorId>` | `{ points: [{ id, grantId, at, lat, lng, accuracy, cursorId }] }`, 500 per page |

The pairing pages (`/native/auth/authorize`, `/callback`, `/approve`) are
browser pages on the API origin, opened by the phone.

## Data lifecycle

- Points are kept 7 days, then pruned by the `*/15` cron.
- Turning an app off deletes its grant and every point under it.
- Disconnecting the phone deletes the device, its grants and points.
- Deleting your account (`DELETE /v1/auth/me`) deletes your devices.
- An app changing owner or being deleted revokes its grants.
- Device credentials expire after 90 days.
