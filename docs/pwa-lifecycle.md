# PWA lifecycle and offline capabilities

Fresh `fas init` app scaffolds install the versioned `pwa` capability. Games keep
their existing foundation. The builder's app scaffold uses the same SDK runtime
and Vite configuration. No existing app repositories are migrated.

For an existing app, run `fas add pwa --dry-run`, then `fas add pwa`. This adds
integration modules and records install/update/offline metadata in
`.fas-capabilities.json`. Existing application files are preserved. Finish the
printed integration steps: install `@freeappstore/sdk >=0.16.15` and
`vite-plugin-pwa`, import `./fas-capabilities/pwa` in `web/src/main.tsx`, and wrap
your existing `VitePWA` options:

```ts
import { pwaOptions } from './fas-pwa-config';
// In plugins:
VitePWA(pwaOptions({ workbox: { navigateFallbackDenylist: [/^\/oauth/] } }));
```

The helper defaults to a public static manifest and build-asset precaching, and
adds API navigation denylists. It preserves app-specific options and custom
denylists. Inline manifests are also supported. Keep the manifest's name, icons,
start URL, scope and display mode appropriate to your app. Custom runtime caches
remain an app-owned decision: audit them for cookies, authorization and private
data. There is no default API response cache. This helper supports `generateSW`;
apps with a custom `injectManifest` worker must implement and review that worker's
waiting/message protocol themselves.

## Update contract

The SDK owns registration; `injectRegister` is disabled. `skipWaiting` is disabled
even if an old config requested it. A waiting worker prompts the user to activate.
After a different worker takes control, a separate button offers page reload.
Neither a controller change nor another tab's activation reloads a page.

Register guards for **every** workflow that has unsaved or active work:

```ts
import { pwa } from './fas-capabilities/pwa';
const removeGuard = pwa.addBusyGuard(() => form.isDirty || recorder.state === 'recording');
// Call removeGuard when the workflow is disposed.
```

Guards are evaluated again at activation and at reload, and exceptions block the
action. They protect this page. Another tab may activate a worker, but this runtime
still preserves the current page until its user requests a guarded reload.
There is no claim that `registerType` alone reloads every tab.

During upgrade from a legacy autoUpdate worker, a newly loaded page uses this
runtime immediately and never automatically reloads on `controllerchange`. An
already open page still running legacy application JavaScript cannot be patched
retroactively; save work and close/reopen those pages when adopting this release.
The old active worker may activate the first upgraded worker automatically; the
new page's reload guard still applies. Subsequent workers wait for approval.

## Offline contract

Installability, a cached shell and offline feature availability are distinct.
The shared Shell banner says only "You're offline." It does not describe save or
sync state: device-local persistence and queued workflows can still save offline.
Apps own save/sync feedback and must use actual storage results before reporting
success. The PWA lifecycle notice describes downloaded shell availability. Cloud
storage, remote media, account operations and model inference are not promised
offline. Browser online/offline events are hints, not proof of server reachability.
Apps can pass verified local feature descriptions to `startPwa({ offlineFeatures })`.

For optional public assets, use `offlineAssets('model-v1', ['/model.bin'])` from
`@freeappstore/sdk/pwa`. Download only after the user asks; `ready()` checks every
declared cache entry, including after eviction or partial failure. Use `read()`
to consume cached responses offline. These caches do not intercept arbitrary
fetches. Version the ID when assets change. `remove()` removes only this asset
set. Downloads omit credentials, reject redirects, cross-origin/query URLs,
private/no-store responses and credential-dependent `Vary` responses. Only declare
public assets: an endpoint that incorrectly labels private data as public cannot
be made safe by a client helper. Handle quota, network and cache failures in the
app and do not report readiness before it is verified.

Navigation fallback serves the precached shell for unvisited SPA links, retaining
the original URL; the app router must render that route. API and app-specific
denylisted paths do not receive the shell. Keep page zoom enabled. Use
`viewport-fit=cover` with safe-area padding; use `touch-action: none` only on a
canvas or another gesture surface, never the page. Check narrow screens and
enlarged text in the app's own layouts.

## Release regression

For #353's offline-local-app behavior matrix, include an initially offline Shell:
the neutral banner remains visible while a synthetic IndexedDB draft is saved and
read back successfully. Verify dismissal, reconnect, repeated disconnects and the
polite status region as well. `shell-resilience.test.tsx` covers these cases with
fake IndexedDB; browser/release validation must also use the delivered package.

`packages/sdk/src/pwa.test.ts` tests guards, independent activation/reload,
legacy-worker control changes, public asset readiness and cache-policy defaults.
The scaffold artifact browser test builds through `fas init`, starts a genuine
worker, updates it, protects a dirty form and an active audio recording, then
reloads offline and opens an unvisited deep link. It also validates manifest
icons, enabled zoom and 320px layout with enlarged text. CI runs it for both app
presets against installed SDK packages. The release must pass these checks on
the delivered SHA; a successful local build alone is not release acceptance.

## Installation in Profile

Requires SDK `0.16.37` or later. The shared runtime retains the browser installation offer without appending an install
promotion footer. The default Profile page offers **Install app** when that offer is
available, in either auth state. It consumes the offer once; opening the browser prompt
does not prove installation succeeded. Installed/unsupported browsers do not get a
nonfunctional button. Browser-specific manual installation remains available through
the browser's own menu.

Custom frames can subscribe to `subscribePwaInstall`, read `getPwaInstallState()` and
invoke `requestPwaInstall()` from `@freeappstore/sdk/pwa` on a user click. These use the
existing controller; do not call `startPwa` again from Profile or each screen.
The runtime keeps actionable update/reload notices and busy guards. Default connectivity
feedback remains in Shell's neutral offline banner (also available as `OfflineBanner`
for custom frames); only explicit `offlineFeatures` create feature-specific PWA status.

## App identity assets

Fresh app starters keep editable artwork in `web/public/icon.svg` and an app-owned
`web/pwa-assets.config.ts`. Their dev/build scripts run the maintained
[PWA Assets Generator](https://vite-pwa-org.netlify.app/assets-generator/cli) first,
using version 1.0.4 (compatible with vite-plugin-pwa 1.x). It generates real PNG install
icons, a separate maskable icon, an Apple touch icon and an ICO fallback. PNG files are
derived build assets, not SVG text renamed to .png; no binary transport through the
builder's text-file map is needed.

The HTML links SVG/ICO favicons and the 180px Apple touch icon. The manifest separately
links 192px/512px PNG icons and a 512px maskable icon. Keep padding/background choices
in the editable preset. Review custom artwork inside the maskable safe area; do not
assume a logo's corners are preserved by every OS mask. The source image and preset
remain app-owned. No store mark, mandatory logo or product layout is required.

Run `pnpm --filter ./web generate:icons` after editing artwork during an existing dev
session. Starting dev or building also regenerates it. To use supplied PNG artwork,
change `images` in the config and update the HTML favicon to that chosen source.
Ready-made icons/custom build pipelines are supported: remove the generation hook and
keep the HTML/manifest declarations consistent with the files the app actually serves.

Existing apps adopt deliberately: add `@vite-pwa/assets-generator@1.0.4` as a web dev
dependency, preserve their pnpm build allowlist while adding `sharp`, copy/adapt the
config, and add generation to their existing dev/build scripts,
and review HTML/manifest changes. Preserve names, theme colors, routes and custom icons.
See [Apple's web clip guidance](https://developer.apple.com/library/archive/documentation/AppleApplications/Reference/SafariWebContent/ConfiguringWebApplications/ConfiguringWebApplications.html).

Release browser checks fetch and decode declared icons, check dimensions and opaque
maskable/touch backgrounds in Chromium and WebKit. They do not claim a physical iOS
Add to Home Screen installation. Browser/OS installation UI remains a separate manual
check when physical-device coverage is required.
