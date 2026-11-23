# FreeAppStore brand

Kit version **2026-11-18**. Canonical source: [`serge-ivo/stores-workspace` `brand/`](https://github.com/serge-ivo/stores-workspace/tree/main/brand). This repo vendors the exact FAS export in [`brand/assets/`](assets/).

## Identity

- **Name:** FreeAppStore, one PascalCase word, with **App** in the accent colour.
- **Symbol:** offset tiles, shared with ProAppStore. Never a letter monogram.
- **Wordmark:** Manrope 800. The exported wordmarks are outlined vectors and need no installed fonts.
- **Colours:** accent `#2563eb`; `#60a5fa` on dark surfaces; icon gradient `#3b82f6`.
- **Typography:** Manrope for UI, Fraunces for editorial headings. The logo never uses Fraunces.

## Assets

| File | Use |
| --- | --- |
| `favicon.svg` | Browser icon and header icon |
| `mark.svg` / `mark-mono.svg` | Transparent symbol, in colour or `currentColor` |
| `wordmark-light.svg` / `wordmark-dark.svg` | Full wordmark for light or dark backgrounds |
| `icon-{16,32,48,64,128,180,192,512}.png` | PNG fallbacks (16/32) and PWA icons (192/512) |
| `apple-touch-icon.png` | Apple touch icon, 180px |
| `og-image.svg` / `og-image.png` | Social card, 1200 × 630 |
| `brand.json` | Kit version and identity values |

## Usage rules

- In a header, show the icon at 28–40px (FAS uses 32px, 8px from the wordmark) with the full name accessible.
- A decorative image beside the name takes `alt=""`. A symbol-only link needs the full name as its accessible label.
- The 192px and 512px PNGs are opaque, full-bleed maskable icons. Do not use them as a square header badge.
- Never redraw, abbreviate or space the name, and never hand-edit an exported SVG or PNG.
- Individual apps and games keep their own names and icons. This kit identifies the platform only.

## Where it ships

Each deployable surface carries its own copy, so none depends on another origin for its identity:

- `sites/storefront/` (freeappstore.online)
- `sites/console/web/public/` (creator console)
- `workers/admin/web/public/` (admin; also `icon.svg`, a copy of `favicon.svg`)
- `ios/FreeAppStore/Assets.xcassets/AppIcon.appiconset/AppIcon-1024.png` (iOS companion app icon): the maskable composition behind `icon-512.png`, rendered at 1024×1024 by the kit's `generate.py` and flattened to opaque RGB. It is a render, not a byte copy.
- `android/app/src/main/res/mipmap-anydpi/ic_launcher.xml` and `ic_launcher_round.xml` (Android companion adaptive launcher icon): background `#2563eb` (`res/values/colors.xml`), foreground and Android 13 themed `<monochrome>` layer `res/drawable/ic_launcher_foreground.xml`, the four tiles of `mark.svg` as VectorDrawable paths in white, placed on the visible 72dp as on `favicon.svg`. A transcription of the SVG geometry, not a redraw. No PNG fallback and no `-v26` qualifier: minSdk is 29.

Each holds `favicon.svg`, `favicon-16x16.png`, `favicon-32x32.png`, `apple-touch-icon.png`, `icon-192.png`, `icon-512.png`, `og-image.png` and a public `brand.json` that makes the deployed revision inspectable.

Reference them with `?v=2026-11-18`. The storefront caches image paths immutably, so new bytes at an unversioned URL can leave the old logo visible.

## Store-specific notes

App layout and ownership follow the [composable starter contract](../docs/composable-starter-contract.md): start from the SDK Shell, keep app-owned layout choices, and use the shared profile page and theme controls.

Use the canonical UI tokens from [DESIGN-SYSTEM.md](../DESIGN-SYSTEM.md), including their light and dark values. Keep platform identity assets separate from app-owned accent choices.

| Token | Purpose |
| --- | --- |
| `--paper` | Page background |
| `--ink` | Primary text |
| `--accent` | Links, primary actions and active states |
| `--muted` | Secondary text |
| `--panel` | Card and panel surfaces |
| `--line` | Borders and dividers |

## Updating

1. Change the master in the workspace kit and regenerate it there.
2. Copy the FAS export to `brand/assets/` and to the three surfaces above.
3. Bump the `?v=` parameter on header, favicon, touch icon, PWA manifest and social-image references together.
4. Run `python3 brand/check-copies.py` in the workspace.
5. Land through this repo's normal `main` workflow.
