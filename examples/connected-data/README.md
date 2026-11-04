# Connected account draft example

This example demonstrates private per-account cloud data with `fas.kv`. It keeps the rest of the app usable while signed out, retries failed reads, preserves typing when an initial read is delayed, and isolates requests when the account changes or signs out.

The built-in profile remains available in both auth states and offers GitHub and Google choices. If an app supplies a custom profile route, render `AccountSection` there rather than replacing it with an account-only prompt.

For queryable public data, explicitly select `fas.collections.collection(name, { visibility: 'public-read' })`. Collections are public-read, owner-write. Realtime rooms remain broadcast channels without private membership enforcement. For durable room-restricted records, use the authenticated [backend data-room API](../../docs/data-rooms.md), which enforces membership; the SDK has no wrapper yet. See the app-owned remediation: [Planning Poker #1](https://github.com/freeappstore-online/planning-poker/issues/1). No real room or user data is used by this example.
