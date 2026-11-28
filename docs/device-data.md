# Desktop and phone apps: where data goes

What the FreeAppStore desktop app, the Android and iOS apps and the console's Generate page store, send and
keep, checked against the code on 2026-11-27 (#849). The public summary is the
[privacy policy](https://freeappstore.online/privacy). How to use the apps: [Desktop and phone apps](devices.md).

This is a technical inventory, not a legal assessment.

## Three different things

1. **App data on the device.** A FreeAppStore app keeps what you make in it on your device
   ([ADR-004](https://github.com/freeappstore-online/platform/blob/main/docs/adr/004-no-server-app-data.md)). The
   desktop app's windows keep their own copy (Electron partition `persist:fas-apps`), separate from any browser's.
2. **Local AI access** (desktop only). The desktop app passes tool calls between an AI app on the same computer and
   your open FreeAppStore apps, over `127.0.0.1`. FreeAppStore's servers receive none of it.
3. **What the AI app does with it.** A tool's result goes to the AI app you connected (Claude Code, Claude Desktop or
   another). If that AI app uses a cloud model, it sends the result to its provider under the provider's terms. The
   local connection cannot change that. Only connect AI apps you trust with that app's data, and use **Pause AI
   access** or the app's **Allow AI access** switch when you don't want it read.

## Local AI access (desktop)

| What | Where it is kept | Source |
|---|---|---|
| Tool calls and results | Passed through in memory; never written, never sent to FreeAppStore | `desktop/src/main/hub.ts`, `mcp.ts` |
| Activity log (time, tool, app, ok or error message; no arguments or results) | Memory only, 200 newest, gone on quit | `hub.ts` `record` |
| MCP token | `userData/mcp-token`, mode `0600` | `token.ts` |
| Claude Code / Claude Desktop config entry | The AI app's own config file; it holds no token | `integrations.ts` |

The server listens on `127.0.0.1:47821` only. `/mcp` needs the token and refuses any request with an `Origin`
header. `/bridge` accepts only `https://<id>.freeappstore.online` pages, each for its own app id. Pausing makes every
tool return an error. An app offers tools only while its **Allow AI access** switch is on.

## Network recipients

Desktop:

| Recipient | What | When |
|---|---|---|
| `<id>.freeappstore.online` | The app itself, plus whatever that app requests | You open an app |
| `freeappstore.online/registry.json`, `api.freeappstore.online/v1/store/votes` | Public app list and vote counts, no credential | Store page |
| `api.freeappstore.online` | Pairing, `/native/me`, Contribute calls, with the device credential and `X-FAS-App-Version` / `X-FAS-Client` | Only after **Connect this computer** |
| Your sign-in provider's avatar host (for example GitHub) | Avatar image request | After connecting |
| `github.com/k2-fsa/sherpa-onnx` releases | Voice model download (350 MB), checked against a pinned SHA-256 | Only when you click **Download** |
| `github.com/freeappstore-online/platform` releases, `api.github.com` | Website-distributed builds: update check (`latest*.yml`) and installer download. All builds: release notes | Start and daily for the direct updater, unless **Check for updates automatically** is off; **What's new**. Microsoft Store packages disable the direct updater and receive updates through Microsoft Store |
| Google Fonts | Fonts for the home screen | Home window opens |

Phones (Android and iOS):

| Recipient | What | When |
|---|---|---|
| `api.freeappstore.online` | Pairing, `/native/me`, location points for apps you turned on, Contribute calls | After connecting |
| `freeappstore.online/registry.json` | Public app list, no credential | Store tab |
| Your browser | Opens the app's page | **Open** |
| `github.com/k2-fsa/sherpa-onnx` releases | Voice model download, pinned SHA-256 | Only on **Download** or an opt-in you confirm |
| Apple Maps (iOS) | The map area you view | Sharing map |
| Your sign-in provider's avatar host | Avatar image | After connecting |

No app here includes an analytics, advertising or crash-reporting SDK. The desktop app has no crash reporter.
Android and iOS write run logs (`Run ended: …`) to the system log on the phone only.

## Account and device records

| Record | Kept | Source |
|---|---|---|
| Device credential (`ndev_`): on the device; the server keeps only its hash | Until **Disconnect** / **Sign out** / **Revoke**, or 90 days | `packages/backend/src/routes/native.ts` |
| Device row: label (desktop: `FreeAppStore desktop (Mac)`; phones: model and OS), client kind, app version label, last seen | Deleted with the device; expired rows pruned every 15 minutes | `native-companion.ts` `pruneNative` |
| QR pair code: SHA-256 of the code, who made it, the device it paired | 30 days after it expires | migration `0062` |
| Pairing rate limit: UTC-day counter keyed by stable, unsalted SHA-256 of your IP | Days older than yesterday pruned daily at 03:00 UTC (normally about 27–51 hours); included in daily JSON backups whose expiry is unverified | `native-auth.ts`, `proxy-rate-limit.ts`, `backup.ts`; [reconciliation](native-store-data-reconciliation.md) |
| Profile on the device (`/native/me`) | Desktop: memory only. Phones: on the phone until disconnect | `desktop/src/main/device.ts` |

## Contribute (community generation)

Optional. Nothing is generated or uploaded until you connect, opt in to at least one app and download the model.

**What the device receives**: the job (app, key, the text to read, model, voice, speed, language) and a lease token.
The app owner wrote the text; it is public input.

**What the device sends**, with your account's credential:

| Sent | Contents |
|---|---|
| Upload (`PUT …/result`) | The audio file (`audio/mp4`) and `meta` with sentence timings. Desktop and phones send `device_kind` `native`; the console sends `web` and a random per-browser `X-Runner-Id` |
| Attempt record (`POST …/generation/events`) | Runner (`android`, `ios`, `desktop`, `browser`), how it ended, error text, app version, OS, device (desktop: CPU model and architecture; phones: model), network type, foreground or background, battery and charging at start and end, thermal state, timings per stage, CPU time, peak memory, size and duration. No text, no audio, no location |
| Report (`PUT …/submissions/:id/report`) | **Good** / **Not good** and an optional note (at most 500 characters) |

**Who sees it**:

- **Everyone**: an accepted recording, its timings and the public manifest (key, size, duration, SHA-256, model,
  accepted time). The manifest does not name the contributor.
- **The app's owner** (the creator who published the app, who can be anyone): for each upload to their app, your
  user id and login (your GitHub username; other sign-ins get a generated name), device kind, attestation, status, your report and note, and
  the attempt record above; also attempts that never uploaded. They can withdraw a recording and block you.
- **You**: your own submissions, from any of your devices.

**Retention on the server**:

| Data | Kept |
|---|---|
| Attempt records | 14 days (`GENERATION_LIMITS.eventsKeepMs`, pruned by the 15-minute cron) |
| Audio not (yet) accepted | Failed checks: deleted at once. Otherwise (pending, superseded, outvoted by replicas) in private quarantine at most 7 days (R2 lifecycle) |
| Accepted recordings | Public until the owner withdraws them or the app is unpublished or deleted |
| Submissions, leases, reports, owner reviews | Until you delete your account, or the app is removed |
| Blocks and the owner's audit log | Until the app is removed. They hold your user id |

**Deleting your account** (`DELETE /v1/auth/me`) deletes your submissions, leases, attempt records, devices, pairings
and pair codes. Accepted recordings stay public with the contributor removed. Blocks and audit rows that name your
user id stay until the app is removed. **Disconnect** or **Sign out** on a device revokes that device only: what you
already contributed stays on the server under your account.

Community generation tables are not in the daily JSON backup (`packages/backend/src/lib/backup.ts` lists the tables
it copies; `users` is one of them). Cloudflare D1's point-in-time recovery can hold earlier database states for a
period Cloudflare sets.

**On the device**:

| Runner | History | Audio kept | Model |
|---|---|---|---|
| Desktop | `userData/contribute-history.json`, 200 newest | `userData/contribute-audio`, 20 newest | `userData/kokoro`, about 400 MB, until **Delete model** |
| Android, iOS | `generation_jobs` in the backup-excluded database | 20 newest, excluded from backup | No-backup storage, until deleted |
| Console Generate page | Run records in this browser's localStorage | Cache Storage, 20 newest | Browser storage |

Desktop **Disconnect** / **Sign out** deletes the history, kept audio and opt-ins, but not the model (#848). The
phones' **Disconnect** clears the opt-ins, the record and the kept audio. **Save record** (desktop), **Share record** (phones) and
**Download record** (console) write a file only where you choose. **Copy diagnostics** puts the capability report and
the latest jobs' reasons and records on the clipboard (no text, audio, notes or credentials); nothing is sent.

**Not covered here**: a private pilot with non-public artifacts (#786, #789) is planned, not built. It will be described
before it runs.

## Location (phones)

Unchanged: see [Native companion: data lifecycle](native-companion.md#data-lifecycle) and the
[privacy policy](https://freeappstore.online/privacy#companion).
