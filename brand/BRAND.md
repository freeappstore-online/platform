# FreeAppStore identity

The canonical eight-store family kit is maintained in `stores/brand` beside the platform repositories. This repository vendors its generated exports in `brand/assets/fas/`; `brand.json` records the identity and version. Regenerate upstream, then copy the exports to the storefront, creator console, and admin public assets together. Do not hand-edit generated SVGs or PNGs.

## Platform identity

- Name: **FreeAppStore**, one PascalCase word, with **App** accented.
- Mark: the shared rounded-square **app grid** icon, never a letter monogram.
- Wordmark: **Manrope 800**. Display headings may use Fraunces; the logo does not.
- Accent: `#2563eb` in light mode, `#60a5fa` in dark mode. Use existing UI tokens.
- Header: local `favicon.svg` at 32 × 32 next to the wordmark. A decorative mark has empty alt text; the link must retain the full store name. Keep 8px between icon and wordmark.
- Social card: `og-image.png` (1200 × 630). Browser icon: `favicon.svg`, with 16px/32px PNG fallbacks. Apple touch icon: 180px. PWA: 192px/512px full-bleed PNGs, suitable for maskable use.
- Exported wordmarks are outlined vectors and need no installed fonts. Use `wordmark-light.svg` on light backgrounds and `wordmark-dark.svg` on dark backgrounds. `mark-mono.svg` inherits `currentColor`.

Individual apps and games retain their own names and icons. This kit identifies the platform; it is not a template for replacing product identities. UI components, themes and accessibility follow the existing design system and SDK guidance.

App layout and ownership follow the [composable starter contract](../docs/composable-starter-contract.md): start from the SDK Shell, keep app-owned layout choices, and use the shared profile page and theme controls.

## UI tokens

Use the canonical tokens from [DESIGN-SYSTEM.md](../DESIGN-SYSTEM.md), including their light and dark values. Keep platform identity assets separate from app-owned accent choices.

| Token | Purpose |
| --- | --- |
| `--paper` | Page background |
| `--ink` | Primary text |
| `--accent` | Links, primary actions and active states |
| `--muted` | Secondary text |
| `--panel` | Card and panel surfaces |
| `--line` | Borders and dividers |

## Distribution

The canonical exports are copied to `sites/storefront/`, `sites/console/web/public/` and `workers/admin/web/public/`. Public `brand.json` files make the deployed revision inspectable. Assets are local to each deployable surface, so admin and creator experiences do not depend on the storefront origin for their identity.
