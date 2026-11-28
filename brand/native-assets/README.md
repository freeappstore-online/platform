# Native icon exports

These are platform derivatives of the existing blue four-tile FreeAppStore brand. The identity
master remains the workspace brand kit, vendored in `brand/assets/`; no tiles or colours are
redesigned here. `app-icon-master.svg` is the generated full-bleed native composition, retaining
the exact gradient and symbol from `favicon.svg`.

Run from the platform repository after `pnpm install --frozen-lockfile`:

```sh
node scripts/native-assets.mjs
node scripts/native-assets.mjs --check
```

The generator uses the locked Sharp renderer, records its component versions and output hashes
in `manifest.json`, and fails on stale assets in check mode. Update the canonical workspace kit
first for identity changes, vendor its exports, then regenerate; never hand-edit generated files.
Renderer upgrades can change edge antialiasing and must receive a new visual review.

| Output | Purpose |
| --- | --- |
| `app-icon-master.svg` | Full-bleed vector export; no baked system mask |
| `app-icon-1024.png` | Opaque sRGB source for iOS, Windows/Linux packaging and listing artwork |
| `mac-icon-master.svg` / `mac-icon-1024.png` | Canonical rounded badge, 824px wide centered on a transparent 1024px canvas, for legacy ICNS packaging |
| `play-icon-512.png` | Canonical 512px store icon with identical RGB pixels and an opaque alpha channel (32-bit RGBA) |
| `contact-sheet.svg` | Review layout: masks, themed mark, light/dark surfaces and small sizes |
| `../../desktop/build/icon.png` | 1024px Windows/Linux source; avoids upscaling the previous 512px image |
| `../../desktop/build/icon-mac.png` | Separate Mac source selected by `mac.icon`; transparent margins and rounded badge |
| `../../ios/FreeAppStore/Assets.xcassets/AppIcon.appiconset/AppIcon-1024.png` | Opaque 1024px iOS app/marketing icon |
| `../../android/app/src/main/res/drawable/ic_launcher_foreground.xml` | Vector foreground and themed monochrome layer, derived from canonical tile rectangles |

The generated raster contact sheet is a local review artifact at
`build/native-assets/contact-sheet.png`. Its labels use the host sans-serif font; they are not
part of any app icon. Mask previews are illustrative rather than pixel-exact OS screenshots.

## Audit, 2026-11-28

The existing iOS icon already had the correct opaque 1024px canvas and composition. It is now
exported by the repository's repeatable pipeline; only rasterizer antialiasing changes. The
desktop sources increase from 512px to 1024px without changing the symbol. Android retains its
existing geometry and solid accent background, including the monochrome layer for themed icons.

The released Mac 1.0.0 ICNS was inspected with `iconutil`: its largest representation was 512px,
and it was fully opaque edge-to-edge. The legacy ICNS derivative now uses the canonical rounded
favicon badge with 100px transparent margins on a 1024px canvas. The generator checks the exact
alpha bounds. This is specifically for the Electron ICNS path, not an instruction to premask
layers for modern Icon Composer. Apple's current guidance recommends unmasked layers for that
modern format. The legacy 100px inset follows the Apple template measurements documented in
[Chromium's macOS icon implementation](https://chromium.googlesource.com/chromium/src/+/4852d4ffeefa31265675175f00edcf84c5e30ecd/chrome/browser/web_applications/os_integration/mac/icon_utils.mm).
The actual installed electron-builder 26.18 icon converter was exercised on the new source and
its ICNS extracted with `iconutil`: it includes a real 1024px representation with alpha bounds
100–923, plus 16–512px representations with visible inset margins. The 16/32px resampler has an
edge-alpha fringe of 1/255; all larger representations have zero outer-edge alpha.

Every corner of the Android symbol's bounds fits inside the central 66dp safe circle on its
108dp layer; the generator enforces this. Both launcher XML files must keep the foreground and
monochrome layer references. PNG dimensions, platform alpha format and sRGB colour space are checked. The
16–96px badge samples and mask previews were visually reviewed for clarity and clipping.

Guidance: [Apple app icons](https://developer.apple.com/design/human-interface-guidelines/app-icons/)
and [Android adaptive icons](https://developer.android.com/develop/ui/compose/system/icon_design_adaptive).
[Google Play's preview-asset requirements](https://support.google.com/googleplay/android-developer/answer/9866151)
specify a 512px 32-bit PNG with alpha, at most 1024KB. The Play export uses alpha 255 throughout;
the generator proves its RGB pixels still equal the canonical image. iOS continues to use RGB
with no alpha channel.

App icon changes require a new signed desktop release or mobile build to reach installed apps.
Store listing artwork can be uploaded separately. This export command builds no application and
publishes nothing.
