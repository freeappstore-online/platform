# ADR-004: FAS stores no application data on the server

## Status

Accepted - 2026-11-26. Implements #801. Retiring the APIs and migrating the
apps that use them is #802.

## Context

FreeAppStore is free forever, and its apps are static PWAs. Over time the
backend gained general-purpose stores for app content: per-user KV
(`fas.kv`), document collections (`fas.collections`), data rooms and photo
uploads. The docs, the AI guide and the builder prompt presented them as the
place for an app's data, and the MCP server gained tools that read and wrote
that data (#734).

That contradicts what FAS is. Holding users' documents makes the free tier a
hosting and database product, with its storage cost, privacy and data-protection
duties, export and deletion obligations, and growth with every user. Server-side
app data and multi-user collaboration are what [ProAppStore](https://proappstore.online)
(PAS) is for.

## Decision

**FAS does not store application data on the server.** The FAS backend
relays, identifies and holds metadata and keys. It never holds app content:
documents, decks, sheets, notes, records, drafts, photos or any other data a user
makes in an app. That content stays on the user's device.

### What the server may hold

Grounded in the D1 tables in `packages/backend/migrations` (see
[architecture: data model](../architecture.md#data-model)):

| Kind | Tables |
|---|---|
| Identity and sessions | `users`, `auth_codes`, `consumed_tokens` |
| Ids and app registry metadata | `apps`, `app_owner_transfers`, `unpublished_apps`, `app_repositories`, `app_deploys`, `app_deploy_limits`, `routes` (host) |
| Keys and proxy configuration | `app_secrets`, `user_api_keys`, `key_providers`, `app_proxy_allowlist`, `app_proxy_usage`, `complimentary_grants` |
| Access and social metadata | `app_roles`, `friendships` |
| Ephemeral relays | Realtime rooms (Durable Objects, nothing persisted) and `app_rooms` for the room cap; email sending; `app_webhooks`, `webhook_deliveries` |
| Notification metadata | `push_subscriptions`, `push_schedules` (pushes carry no payload; the app's service worker shows its own text) |
| Store metadata, platform analytics, health and diagnostics | `app_analytics`, `app_votes`, `idea_builders`, `health_checks`, `audit_results`, `fleet_audit_reads`, `error_log`, `app_logs` (7-day retention), `counters` (numbers only) |
| Platform tooling | `agent_sessions` (VibeCode builder sessions, not app data) |

Two features keep data under their own decisions, as bounded platform services
rather than an app's store: native companion locations (`native_*`, 7-day
retention, reviewed apps only, [ADR-002](002-native-companion.md)) and community
generation (owner-defined public assets, [ADR-003](003-cross-app-community-generation.md)).
Neither is a place for an app to keep user content.

### What must not be stored there

- App content in any form: per-user values, documents, records, drafts,
  settings that are the user's work, files and photos.
- Shared or collaborative content between users of an app.
- No new backend route, SDK module, MCP tool or starter capability that stores,
  reads or syncs app content may be added to FAS.

### Where app data goes instead

- **Device-local:** `@freeappstore/sdk/persist` (preferences, IndexedDB records,
  files), with `@freeappstore/sdk/backup` for user-held export and import files.
- **Moving data between devices:** a backup file the user carries, or a live
  transfer relayed through realtime rooms, where nothing is persisted.
- **Local AI access:** the local desktop bridge (#797). An AI client on the
  user's machine works on an open app's data in the browser; FreeAppStore's
  servers never receive it. The AI client gets what the tools return and, if it
  uses a cloud model, sends it to its provider (#849).
- **Server-backed or multi-user data:** PAS. A collaborative Sheets lives on
  PAS; the FAS spreadsheet is a single-user, local, AI-assisted tool.

## Drift today

These APIs hold app data on the server and are **deprecated for app data**:

- `fas.kv` (`kv` table)
- `fas.collections` (`documents`, `collection_settings`) and `fas db share`
- data rooms (`data_rooms`, `data_room_members`, `data_room_documents`)
- photo uploads, `fas.photos` (`photos` table, R2 `fas-uploads`)

They keep working for the apps that already use them (19 apps at the time of
writing, listed in #802). Their reference sections stay, labelled deprecated, only
as far as those apps need them. No new example, guide or prompt uses them. The
connected starter still generates a `fas.kv` draft (`ConnectedDraft`) and the CLI
`cloud-data` capability guide; both are starter runtime and change with #802.
#802 retires the APIs, migrates each app (device-local, relay-only, or PAS) and
removes the tables once existing data is exported or users have had notice.

The MCP app-data tools from #734 (`app_guide`, `app_data_*`) were removed with
this decision.

## Consequences

- An app's own data never depends on a FAS account or on the FAS backend. Sign-in
  remains for identity, rooms, the proxy and key vault, email and push.
- Cross-device sync is not a FAS feature. Users carry backups or move to a PAS app.
- Builders and AI agents are told the same rule in the docs, the AI guide
  (`skills.md`), the MCP `sdk_reference` text and the VibeCode prompt.
- Until #802 lands, the deprecated APIs still accept writes; this ADR changes
  guidance, not runtime behaviour.
