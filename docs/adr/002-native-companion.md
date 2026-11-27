# ADR-002: FAS native companion

## Status

Accepted - 2026-11-23. Implements #616 (backend) and #617 (iOS). Adapted from
[PAS ADR-015](https://github.com/proappstore-online/platform/blob/main/docs/adr/015-native-companion.md)
and [PAS ADR-016](https://github.com/proappstore-online/platform/blob/main/docs/adr/016-ios-native-companion.md).

Current status (2026-11-27): this record keeps the original, location-only
decision. Since then the Android app was built (#621), both phone apps gained
Store, Account and Contribute, and the desktop app pairs with the same protocol.
See [Desktop and phone apps](../devices.md) and the [roadmap](../roadmap.md).

## Context

FAS apps are web apps. When the phone locks, iOS Safari suspends the page, so
an app like Run cannot keep recording a route. No supported web API fixes that.

## Decision

1. One **FreeAppStore companion** phone app collects location in the background
   for the FAS apps its user turns on. Users stay in their web apps; the
   companion is only for connecting, consent and pausing. iOS first (`ios/`,
   Swift/SwiftUI); Android later.
2. Same protocol as PAS, vendored, not shared: pairing with a device-held
   verifier and browser approval, a narrow, expiring `ndev_` device credential,
   per-app grants bound to the exact disclosure wording and the app's owner,
   idempotent upload, 7-day platform retention.
3. FAS fit:
   - Pairing sign-in is the FAS code flow (`response_mode=code` + PKCE) with the
     first-party return id `native`, accepted only for
     `https://api.freeappstore.online/v1/native/auth/callback`. The minted
     session is only verified, never stored.
   - Grants bind to `apps.owner_id`; an owner change or app deletion revokes them.
   - An app reads its users' points only with a session delivered to that app
     (`aud` = app id). Console, cross-store and other-app sessions are refused.
   - No foreign keys to `users`/`apps` (FAS convention); account deletion clears
     `native_devices` and `native_pairings` explicitly, and device → grants → points cascade.
   - Recipients are a curated list in `packages/backend/src/lib/native-companion.ts`.
     First: Run.
   - Rate limits reuse `app_proxy_usage` daily counters: 30 pairings per IP,
     6,000 uploads per device.
4. Distribution is direct developer install from Xcode for now. No App Store
   or TestFlight submission is implied.

## Consequences

- "Nothing to download" stays true for every FAS app; the companion is an
  optional add-on for apps that need the phone locked.
- Two stores now carry the same protocol. A protocol fix in one store is ported
  to the other by hand (stores/CLAUDE.md "Vendor, don't depend").
- iOS may still stop the app or withhold accurate fixes. A gap stays a gap.

See [native companion protocol](../native-companion.md).
