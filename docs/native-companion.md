# Native companion

The FreeAppStore phone app keeps collecting location with the screen locked and
hands it to the FAS apps you turn on. Decision record: [ADR-002](https://github.com/freeappstore-online/platform/blob/main/docs/adr/002-native-companion.md).

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

## On the phone (iOS)

- **Pause all** stops new samples. **Pausing one app** stops tagging new samples for that app only; its grant,
  consent and platform copy are unchanged, and it resumes without a new disclosure. Previously authorized queued
  samples can still upload in both cases. Pause is local to the phone and is not reported to the app.
- The companion keeps a 30-day on-device history (`share_events`, `share_points`) in its protected queue
  database, for your own sharing map, session timeline and **Activity** log (sharing changes, upload and
  permission problems). It is never uploaded, is excluded from backups, and is deleted by **Clear sharing
  history** or **Disconnect this phone**.
- The sharing map draws that history from the phone. Map backgrounds come from Apple Maps, so Apple receives the
  map area you view; your shared track is not sent to Apple or to FreeAppStore when you view it.
- The **Store** tab lists every public FAS app from `https://freeappstore.online/registry.json`, fetched
  without credentials (conditional GET, cached on the phone so it works offline, kept across disconnect).
  **Open** goes to the app in the browser; the first time for each app it shows how to add it to the Home
  Screen (Share → Add to Home Screen), with **Don't show this again**. Apps on the recipient list get **Use with
  companion**, which opens the same disclosure as the Sharing tab. Browsing never creates a grant.

## On the phone (Android)

- `android/` is the Android port (package `online.freeappstore.companion`) with the same pairing, per-app consent,
  Pause all, per-app pause and upload queue. It has no on-device sharing history yet.
- Its **Store** tab lists `https://freeappstore.online/registry.json` (cached, revalidated, fetched without
  credentials). **Open** goes to the app at `?install=1`. The host then adds `/.fas/install.js`, which shows an
  **Install** button when Chrome offers to install the app. Without the parameter, apps are served unchanged.
