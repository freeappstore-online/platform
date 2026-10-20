# Browser Capabilities

What a hosted app (`<id>.freeappstore.online`) can use in the browser, and what the platform still limits.

The rule is **default-open**: an app gets everything a normal website on its own origin gets. The browser
asks the user before granting anything sensitive (microphone, camera, location, sensors, devices),
so the platform doesn't block those features as well. A feature stays blocked only with a written
reason, listed below.

The headers are set by the host Worker (`workers/host/src/host.ts`), unit-tested there, and checked on a
live app every 30 minutes by the prod smoke workflow.

## Permissions-Policy

Every feature below is granted to **your app's own origin** (`=(self)`). Cross-origin iframes your app
embeds don't receive them, even with an `allow` attribute.

| Capability | API | Used by | State |
|---|---|---|---|
| Microphone | `getUserMedia({ audio })` | recorders, tuners, voice effects, speech | allowed |
| Camera | `getUserMedia({ video })`, `BarcodeDetector` | scanners, barcode/ISBN readers, photo tools | allowed |
| Location | `navigator.geolocation` | prayer times, weather, maps, run trackers | allowed |
| Motion & orientation sensors | `DeviceOrientationEvent`, `DeviceMotionEvent`, Generic Sensor API (accelerometer, gyroscope, magnetometer, ambient light) | compasses, spirit levels, tilt games, step counters | allowed |
| MIDI | `navigator.requestMIDIAccess()` | synths, drum pads, music learning | allowed |
| USB, serial, HID, Bluetooth | `navigator.usb` / `.serial` / `.hid` / `.bluetooth` | firmware flashers, Arduino tools, controllers, BLE heart-rate | allowed |
| Gamepad | `navigator.getGamepads()` | games, controller testers | allowed |
| Screen capture | `getDisplayMedia()` | screen recorders, sharing | allowed |
| Clipboard read & write | `navigator.clipboard` | editors, paste-in tools | allowed |
| Passkeys | WebAuthn `navigator.credentials` | app-level sign-in | allowed |
| Screen wake lock | `navigator.wakeLock` | timers, recipes, workouts | allowed |
| Fullscreen, picture-in-picture | `requestFullscreen()`, `requestPictureInPicture()` | games, video | allowed |
| Autoplay, encrypted media | `<audio>`/`<video>` autoplay, EME | sound apps, media players | allowed |
| Web Share | `navigator.share()` | sharing results | allowed |
| Idle detection, local fonts, storage access, window management, WebXR | respective APIs | design tools, multi-screen, AR/VR | allowed |
| Payments | Payment Request API, Apple Pay | checkout, tips | **blocked**: FreeAppStore apps take no payments ([#289](https://github.com/freeappstore-online/platform/issues/289)) |
| Topics API | `document.browsingTopics()` | ad targeting | **blocked**: shares the user's ad interests with third parties; the store requires apps not to track users |

The browser still asks the user, needs a secure context (always true on the host), and for most of these
needs a user gesture. Handle `NotAllowedError` (the user said no) and missing hardware. Declare the
ones that prompt in your manifest so your listing explains them: see [Permissions](permissions.md).

**Inside the storefront preview** (the phone frame on an app's listing, the homepage preview and
the quality dashboard), the same features work. The storefront delegates every feature above to
`*.freeappstore.online` app origins through its Permissions-Policy and the preview iframe's `allow`
attribute. Users still get an **Open in new tab** link. One difference: the browser's permission
prompt in the preview names freeappstore.online, the page the user is on, and a grant there is
separate from a grant in the app's own tab.

## Content-Security-Policy

| Capability | State |
|---|---|
| Scripts from your origin and any `https:` origin, inline scripts, `eval` | allowed |
| WebAssembly (`'wasm-unsafe-eval'`) | allowed |
| Web Workers and Service Workers from your origin, `blob:` workers (pdf.js, ffmpeg.wasm, Monaco, emscripten) | allowed |
| `fetch`/XHR to your origin, any `https:` API, `wss:` websockets, `data:` and `blob:` URLs | allowed |
| Images, media, fonts from your origin, `https:`, `data:`, `blob:` | allowed |
| Embedding `https:` iframes in your app | allowed (they don't get the features above; see [#288](https://github.com/freeappstore-online/platform/issues/288) for media players) |
| Plain `http:` requests | upgraded to `https:` |
| `<object>`/`<embed>` plugins | blocked: obsolete plugin content, a common script-injection vector |
| Your app framed by other sites | blocked: only `freeappstore.online` and its subdomains may frame your app, which prevents clickjacking |

## No payments

FreeAppStore apps are free forever and take **no payments** (owner decision,
[#289](https://github.com/freeappstore-online/platform/issues/289)). It's enforced in two places:

- The host sends `Permissions-Policy: payment=()`, so the Payment Request API can't run, in your app
  or in its storefront preview.
- `fas check` fails the **No payments (free tier)** check on the Payment Request API, Apple Pay,
  payment-provider SDKs and checkout endpoints (Stripe, PayPal, Paddle, Lemon Squeezy, Gumroad,
  Google Pay), payment SDK dependencies, and payment members in the web app manifest.

Words like "payment" in your own code are fine (a loan calculator passes). A link to your own external
donation or sponsor page isn't covered by the check. To charge for an app, publish it on
[ProAppStore](https://proappstore.online), which handles subscriptions and creator payouts.

## Cross-origin isolation

`SharedArrayBuffer` and threaded WebAssembly need `crossOriginIsolated`, which the host doesn't enable
yet. It would break third-party images and embeds and popup `window.opener` links for every app.
A per-app opt-in is [#286](https://github.com/freeappstore-online/platform/issues/286).

## Platform services

The SDK's server-side limits (KV, collections, rooms, proxy, email, push) are in [Limits](platform-limits.md).
`fas check` measures the largest JavaScript file. Making it ignore lazily loaded WebAssembly and workers
is [#290](https://github.com/freeappstore-online/platform/issues/290).
