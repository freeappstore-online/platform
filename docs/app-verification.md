# Verify an app people can actually use

This is a practical recipe, not a required layout or feature bundle. Choose the checks
that match the feature. An AI or developer should distinguish checks actually run from
checks still pending. Passing compliance or a transpiling build alone does not prove
that an app opens, saves data or accepts typing.

## Before implementation

Choose the feature's data boundary: this browser, private account, public shared data,
or an authorized room. Decide what offline means for that feature. Signing in does not
automatically synchronize IndexedDB. Choose optional capabilities up front or later
with the same preview/apply workflow; read the installed integration guides.

Keep the app's routes, domain model and visual design app-owned. Use the SDK Shell and
accessible controls when they fit. A custom frame can meet the same requirements.

## First useful feature

Run typecheck, test and build in the app checkout. TypeScript must check the real SDK
imports; transpilation alone accepts calls to nonexistent APIs.

Exercise one representative flow with synthetic data:

1. Open a fresh browser context. The empty screen must load without console errors.
2. Add a record through labelled controls. Type a multi-character value sequentially,
   with focus retained after each character. Programmatic fill alone hides focus bugs.
3. Save, reload a direct feature URL and verify the stored record, not just a toast.
4. Edit and delete it; verify the result after reload.
5. Submit an empty, malformed and boundary value. Reject the whole invalid value.
   Avoid permissive numeric parsing that turns “40junk” into 40.
6. Test a known calculation against a hand-computed example. Domain arithmetic belongs
   in the app's tests, not a generic template rule.
7. Open Profile from a route containing a query and fragment, then close it. Preserve
   both the URL and the correct app screen. Also test direct Profile entry.
8. At 320px and enlarged text, inspect actual controls, not only scrollWidth. Cropped
   inputs, overlapping actions and focus loss can all occur without horizontal overflow.

If browser execution is unavailable, say which flows were not exercised. Do not label
the app “tested” on the strength of a build alone.

## Data safety and optional features

- Persistence: distinguish absent data from read failure; preserve unreadable bytes.
  Show saved only after a successful transaction. Simulate a rejected write.
- Backup: validate the entire payload, preview counts, require an explicit mode, test a
  corrupt file and unsupported version, and inject an apply failure. Report a failed
  rollback as potentially partial data. A schema cannot silently discard bad records.
- PWA: first visit online, then reload a deep link offline. Test the actual update prompt
  and a dirty form or recording guard. Installation does not make server features offline.
- Account data: use synthetic identities and mocked API calls for account-switch tests.
  Do not perform real OAuth, send messages or mutate real accounts as routine QA.

## App identity

Check the page title, app name, browser favicon and install icon separately. The favicon
needs an HTML icon link; a manifest icon is a different relationship. Fetch the actual
declared asset and check it is an image rather than an HTML fallback or a 404.
Use app-owned artwork; the starter icon is a placeholder.

Fresh starters generate PNG install/touch icons and an ICO favicon fallback alongside
the SVG. Verify the built files, not just the source declarations. Existing apps need
to adopt or supply those assets explicitly; a manifest link alone does not provide them. See [MDN's icon relationship](https://developer.mozilla.org/en-US/docs/Web/HTML/Reference/Attributes/rel#icon)
and [Apple's web clip guidance](https://developer.apple.com/library/archive/documentation/AppleApplications/Reference/SafariWebContent/ConfiguringWebApplications/ConfiguringWebApplications.html).

## Completion evidence

Record the source revision, actual installed SDK version, checks run, runtime flows,
remaining limitations and data location. A pushed revision, successful deployment,
reachable URL and working feature are distinct milestones. For an existing PWA, verify
the update path as well as a clean browser load.

## Maintained authoring examples

Examples are optional starting points. Complete examples must compile; API fragments
need their stated app/handler context and are not standalone programs.

| Example | Source and coverage |
| --- | --- |
| Shell/Profile routing | Complete MCP Shell example; whole-program typecheck and query/hash navigation regression. Replace its example app identity. |
| Editable forms | Shared form body in MCP `forms`, the UI guide and browser fixture; typing, validation, pending/rejected writes and focus tests. |
| Private account data | MCP `connected-data` uses the connected starter's actual component; typed with its controller import. Generated connected/account-switch tests cover stale responses and private-feature boundaries. |
| Persistence/backup | Shared complete examples, compiled against SDK types; SDK tests cover failed writes, validation and rollback failures. |
| PWA | Actual installed controller module is compiled; SDK and artifact-browser tests cover activation, busy work, reload and offline routes. |
| Realtime | Actual optional room wrapper is compiled; SDK lifecycle tests cover closed-room callbacks and reconnect cleanup. Room broadcasts are not private durable data. |
| Media | Actual optional module is compiled and the delivered busy-guard expression is exercised with no recorder, inactive, paused, recording and unsaved states. Permission/cleanup behavior remains in SDK media tests. |
| KV/counters/collections/rooms call shapes | MCP API fragments are typechecked in an explicitly initialized app context. Calls belong in authorized feature handlers; public-read filters do not establish confidentiality. |

Scaffold release checks also typecheck the prepared example feature against the installed
published SDK before building it. Keep this separate from checking SDK source: passing
against an unpublished checkout does not establish that the installed package supports
the imports. Do not require any example's model, layout or source text in consumer apps.


Include a feature → Profile → Close profile round trip while a meaningful feature
state exists (a draft, reading position or selected record). Verify that app-owned
state survives as intended, ongoing work pauses safely, and returning does not
silently resume capture/playback. A return URL alone does not preserve component
state.
