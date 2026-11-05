# Cue Scroll: qualitative creation review

2026-11-05. Follow-up to [#401](https://github.com/freeappstore-online/platform/issues/401)
and [#405](https://github.com/freeappstore-online/platform/issues/405).
Development was local, directly on main. No measurement framework, baseline run,
intervention counter, timings dashboard or scoring was added.

## What was built

[Cue Scroll](https://cue-scroll.freeappstore.online) implements the front site's
[Teleprompter idea](https://freeappstore.online/ideas/#idea-teleprompter): saved
scripts, adjustable scrolling and text size, mirror mode, pause controls and
optional screen wake lock. Scripts stay on the device. Sign-in is optional and
does not imply script synchronization.

The starting point was published CLI 0.4.73, standalone plus the optional
persistence capability. The app adopted SDK 0.16.38 and used published CLI 0.4.74
for compliance and offline artifact diagnosis as findings were fixed. CLI 0.4.75
subsequently delivered the generic configured-test deployment gate.

App source: [freeappstore-online/cue-scroll](https://github.com/freeappstore-online/cue-scroll).
The initial feature commit is `964a89de4792985f81185833c97bd27b86f7dfc7`;
the final mobile-layout correction is `53ace47c94b88795c08172666b5f1035221ef6ab`.
Both deployed successfully with app-owned unit and browser tests before upload.

## What improved from the Pitstop experience

| Area | Result in this build |
|---|---|
| App frame | Shared avatar/Profile and close control worked without rebuilding authentication or adding a topbar sign-in CTA. No install promotion footer appeared. |
| Forms | The optional form/dialog recipe provided controlled fields, labels, validation, pending guards and failure handling. Sequential typing and rejected saves worked. |
| App identity | An app-owned SVG generated the ICO, Apple touch PNG, normal PNGs and separate maskable PNG during the normal build. No manual raster export was needed. |
| Storage | Persistence could be requested at creation. Committed writes and typed failure results supported a local-first feature without forcing an account or a product schema. |
| Provisioning | The existing local session provisioned the app repository, hostname and listing through fas publish. No additional publishing permission or remote coder was needed. |
| Verification | Doctor inspected the actual target and assets offline and kept unexecuted stages explicit. Browser checks exercised real behavior and decoded deployed icon files. |
| Dependencies | Normal installation created the app lock. The deployment reused it and accepted the actual source before upload. No blanket lock deletion or latest-version substitution was needed. |

The creation path was straightforward for those pieces, but the overall exercise
was not friction-free. The findings below were repaired rather than hidden in
this app or treated as proof that one successful build establishes reliability.

## Findings and reusable fixes

**Starter checks contradicted their output.** Publishing surfaced PWA, CSS and
contributor-guide warnings from canonical defaults. [#416](https://github.com/freeappstore-online/platform/issues/416)
fixed the shared shell/font cache defaults, version-aware recognition of the SDK
helper, CSS base layers/token fallbacks, current guide links and generated-file
ignores. An arbitrary feature-class count warning was removed. App-owned layered
CSS remains supported. Business JSON, WASM, media and private API caching remain
explicit choices; shell caching is not a full-app offline promise.

**Release correctness needed executable gates.** [#417](https://github.com/freeappstore-online/platform/issues/417)
found that SDK 0.16.37's compiled runtime still reported 0.16.36. Publication now
rebuilds after version synchronization and acceptance inspects the actual SDK
archive. [#418](https://github.com/freeappstore-online/platform/issues/418) added
configured app tests before generated deployments accept a build; absent test
scripts and app-owned browser-tool choices remain supported.

**Profile restores a location, not component state.** Browser testing found a
reading-position/mirror reset in [cue-scroll #2](https://github.com/freeappstore-online/cue-scroll/issues/2).
The app now owns its reading session above the feature subtree and pauses on
unmount. Shared guidance explains this lifetime and distinguishes PWA update
guards from navigation guards. This did not require teleprompter state in Shell.

**Passing width checks did not ensure useful mobile composition.** Visual review
found secondary controls pushing the script down the initial viewport
([cue-scroll #3](https://github.com/freeappstore-online/cue-scroll/issues/3)). A
native details/summary disclosure keeps the script prominent; keyboard handling
respects that native control. Browser coverage now checks primary-surface
visibility as well as horizontal reflow. This remains an app-owned layout.

**Automation needed real changed-release runs.** [#419](https://github.com/freeappstore-online/platform/issues/419)
fixed the pinned platform build's working directory. Automatic CLI 0.4.74 mirror
adoption completed at `fe16662a3fdb5292deb77fce2f64008d31a4a967` and
`f08428dc1186f8d050d9151769be1fa6998f285f`, with exact-SHA CI and compliance.
CLI 0.4.75 changed a workflow, which the default GitHub CI token cannot push.
[#420](https://github.com/freeappstore-online/platform/issues/420) adds preflight
and an optional scoped automation credential. Current 0.4.75 adoption used the
authorized local maintainer path at `3c8bc8051e4644861bd93c35d47650c2a655e6e4`
and `a17975e4543e71e0da8436b551f957c2c3cc8979`, with CI/compliance passing.
Ordinary file updates are automatic. Future workflow changes need Workflows write;
no human credential was copied into CI. Earlier release-auth, registry and browser
runner failures also received explicit fixes and bounded recovery.

## Template boundary and verification limits

Keep one shared foundation with standalone/connected presets, optional
capabilities available upfront or later, and tested composition recipes. The
platform supplied the frame, Profile/preferences, PWA lifecycle, icons, storage
APIs, build contract and verification path. Script schemas, conflict decisions,
scrolling, wake-lock behavior and reading composition belonged to the app.
Another vertical template or mandatory state/data framework would not have
prevented the app-specific bugs above.

Five app unit tests and six browser scenarios passed locally and against the live
app, across desktop Chromium, mobile Chromium and WebKit. They cover typing,
validation, quota failure/retry, reload, stale-tab conflict, playback, native
settings, Profile return, enlarged text at 320px, real icon decoding and offline
saved-script reading. A StrictMode regression protects against stale initial
loads. The platform also retains both-preset, builder-foundation, custom-target
and published-example regression coverage.

This was one CLI-authored app. It was not a new independent creator's full builder
session. Physical home-screen installation, a physical-device wake lock and a new
interactive GitHub/Google OAuth login were not performed. Those remain distinct
from successful engine tests, static checks and deployment.

The original Pitstop **Load sample data** control is its optional demo-data action,
not a template requirement. The generic installation/offline promotion footer came
from the shared PWA runtime and has been removed; browser-supported installation
is available through Profile.
