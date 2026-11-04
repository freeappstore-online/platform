# Connected account draft example

This example demonstrates private per-account cloud data with `fas.kv`. It keeps the rest of the app usable while signed out, retries failed reads, preserves typing when an initial read is delayed, and isolates requests when the account changes or signs out.

The built-in profile remains available in both auth states and offers GitHub and Google choices. If an app supplies a custom profile route, render `AccountSection` there rather than replacing it with an account-only prompt.

For queryable public data, explicitly select `fas.collections.collection(name, { visibility: 'public-read' })`. Collections are public-read, owner-write. Realtime rooms remain broadcast channels without private membership enforcement. For durable room-restricted records, use the authenticated [backend data-room API](../../docs/data-rooms.md), which enforces membership; the SDK has no wrapper yet. See the app-owned remediation: [Planning Poker #1](https://github.com/freeappstore-online/planning-poker/issues/1). No real room or user data is used by this example.

## Connected builder session ownership

The agent generator accepts `getTemplateFiles(config, archetype, 'connected')` for
all four app archetypes. New builder sessions can select it with `preset: 'connected'`
in the first chat body or the `X-App-Preset` header, alongside the archetype.
Existing sessions and customized files are preserved; standalone remains the default.
This is the auth correction for #368; broader resolver/template convergence remains #352.

The generated `App.tsx` owns the single SDK instance and passes it to both `Shell`
and `ConnectedDraft`. Feature components must accept that instance rather than call
`initApp` again. Home and About stay public. Only the private editor gates on the
shared auth state, so profile sign-out hides its data and prevents further saves.
The preset requires SDK 0.16.26 or later. Deployment's `applyPlaceholders` resolves
the source `APPID` literal to the deployed id; name substitution alone intentionally
leaves that source literal for the deployment step.

`packages/sdk/src/generated-connected.test.tsx` compiles and mounts the generated
source with real SDK/React/profile components and synthetic fetch responses.
It covers every archetype and sign-out with a private draft still mounted, including
a retained Save handler. Agent tests cover preset persistence and deployment identity.
These are DOM runtime checks; mobile visual/release checks remain in #353.
