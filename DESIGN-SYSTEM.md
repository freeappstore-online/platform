# Design System

This is the platform-local copy of the shared [storefront design system](https://github.com/serge-ivo/stores-workspace/blob/main/DESIGN-SYSTEM.md),
maintained here for FAS development and CI. Keep shared contract changes aligned
with that document. FAS implementation guidance lives in [docs/ui.md](docs/ui.md#styling)
and [ADR-001](docs/adr/001-tailwind-on-fas-tokens.md).

Standard visual language across the **storefront stores** — FAS, FGS, FWS, PAS, PGS, PWS, FAGS. Only **accent color** and **brand mark** vary per store — fonts, sizing, spacing, components, dark mode, and controls are identical everywhere.

> **Source of truth for the stores it covers.** If this file disagrees with a covered site's CSS, the site is wrong.
> See [Enforcement](#enforcement) for how violations are caught.

## 0. PAGS is out of scope (decided 2026-08-07)

**ProAgentStore does not follow this document.** It has its own design system, maintained in
`pags/platform`. This is a decision, not drift — recorded here so the next reader does not measure
the PAGS console against a ruler it was never meant to fit.

It had already diverged on the load-bearing point before the decision was made:

| | This document | PAGS console |
|---|---|---|
| Themes | light **and** dark, `data-theme` on `<html>` | **dark only** |
| Theme storage | `stores-theme`, shared so the preference follows a user between stores | none — no light theme to switch to |
| Status colours | `--danger` / `--success` / `--warning` (+ `-soft`) | its own tokens, dark-only values |

**The known cost, stated so it is not rediscovered as a bug:** a user moving between a storefront
store and the PAGS console gets a theme discontinuity. That is accepted.

**What PAGS keeps, because it is good practice rather than a cross-store contract:** semantic status
tokens and the rule *never hardcode red/green/yellow hex*. Owning a design system is a reason to have
named tokens, not a licence to scatter Tailwind literals — ProAgentStore/platform#368 is what the
absence of that rule looks like (11 light-theme `bg-*-100 text-*-700` badges on a dark-only app).

Everything below applies to the storefront stores. PAGS's equivalent lives in
`pags/platform/DESIGN-SYSTEM.md`.

## 0.5 Styling model

**React + Tailwind 4 on tokens is required for all React UI in every storefront
store**, including apps, storefronts, SDK Shell and UI components, console,
dashboard and admin. The PAGS exclusion in §0 still applies.
In this repository that includes `packages/sdk/src/ui`, `sites/console`,
`sites/storefront` and `workers/admin`.
Follow the three layers from [PAS ADR-011](https://github.com/proappstore-online/platform/blob/main/docs/adr/011-tailwind-on-pas-tokens.md), in order of preference:

1. **Components** for repeating buttons, cards, inputs, dialogs and empty states:
   use the store's SDK UI or app-local shared components.
2. **Tailwind utilities on tokens** in React `className` for layout and one-off
   styling, for example `text-ink bg-panel border-line` via §6's mapping.
3. **The CSS entry point** contains only `@import "tailwindcss"`, `@source`,
   `:root` / `:root[data-theme="dark"]` token blocks, `@theme inline`, and
   `@layer base` / `@layer components`. No unlayered rules, feature classes, or
   hex colours outside token blocks. `@media print` is allowed for print sheets.

Inline `style` is allowed only for dynamic values computed at runtime (such as
progress width or pointer coordinates); static presentation belongs in utilities.
No runtime-injected CSS strings, including injected `<style>` elements.
The token contract also applies to non-React pages.

## 1. CSS custom properties (the contract)

Every page in every store must define these variables in `:root` and `[data-theme="dark"]`. No aliases, no extras for the same concept.

### Layout & surfaces

| Token | Light | Dark | Purpose |
|-------|-------|------|---------|
| `--paper` | `#f8fafc` | `#0f172a` | Page background |
| `--panel` | `#ffffff` | `#1e293b` | Opaque card / elevated surface |
| `--popover` | `var(--paper)` | `var(--paper)` | Opaque floating UI: menus, drawers, popovers, modals, toasts |
| `--panel-glass` | `rgba(255,255,255,0.72)` | `rgba(30,41,59,0.8)` | Optional decorative glass; always paired with `backdrop-filter` |
| `--panel-alt` | `#f1f5f9` | `#0f172a` | Secondary surface (sidebar, code block bg) |
| `--ink` | `#1e293b` | `#f1f5f9` | Primary text |
| `--ink-strong` | `#0f172a` | `#ffffff` | Headings, emphasis |
| `--muted` | `#64748b` | `#94a3b8` | Secondary text, placeholders |
| `--line` | `#e2e8f0` | `#334155` | Borders |
| `--line-strong` | `#cbd5e1` | `#475569` | Emphasized borders (hover, focus) |

### Opaque surfaces and opt-in glass

`--paper`, `--panel` and `--popover` must resolve to alpha = 1 in both themes,
including through aliases and overrides. `--panel` never means glass. Floating UI
uses `--popover`, defaulting to `var(--paper)`; do not apply translucent backgrounds
or opacity utilities to its surface container. A separate modal scrim may be translucent.

Glass is an explicit opt-in: use `--panel-glass` with `backdrop-filter`, for example
`bg-panel-glass backdrop-blur-md`. It is for decorative panels, never floating UI.
If blur is unsupported, fall back to opaque `--panel`. The glass token is optional;
all other surface tokens are required. Do not lower `--panel` opacity to obtain glass.

### Accent (per-store)

| Token | Purpose |
|-------|---------|
| `--accent` | Primary action color (buttons, links) |
| `--accent-hover` | Hover state |
| `--accent-soft` | Tinted background (badges, highlights) |

Accent values per store (from BRAND.md):

| Store | `--accent` | `--accent-hover` | `--accent-soft` |
|-------|-----------|-----------------|----------------|
| FAS | `#2563eb` | `#1d4ed8` | `#eff6ff` |
| FGS | `#10b981` | `#059669` | `#ecfdf5` |
| FWS | `#0891b2` | `#0e7490` | `#ecfeff` |
| PAS | `#7c3aed` | `#6d28d9` | `#f5f3ff` |
| PGS | `#9333ea` | `#7e22ce` | `#faf5ff` |
| PWS | `#334155` | `#1e293b` | `#f8fafc` |

Dark-mode accent values shift lighter (e.g., PAS dark: `--accent: #a78bfa`). Each store defines its own dark accent in its CSS.

### Status (semantic)

Shared across all stores (not per-store like accent). Use these for validation,
alerts, badges, and state — never hardcode red/green/yellow hex. `*-soft` is the
tinted background pairing for the solid color (e.g. an error banner: `--danger`
text/icon on `--danger-soft` background). Dark values lighten the solid tone for
contrast and darken the soft tone.

| Token | Light | Dark | Purpose |
|-------|-------|------|---------|
| `--danger` | `#dc2626` | `#f87171` | Errors, destructive actions |
| `--danger-soft` | `#fef2f2` | `#450a0a` | Error background / banner |
| `--success` | `#16a34a` | `#4ade80` | Success, confirmation |
| `--success-soft` | `#f0fdf4` | `#052e16` | Success background |
| `--warning` | `#ca8a04` | `#facc15` | Warnings, caution |
| `--warning-soft` | `#fefce8` | `#422006` | Warning background |

### Shape

| Token | Value | Purpose |
|-------|-------|---------|
| `--radius-sm` | `0.5rem` | Small elements (badges, inputs) |
| `--radius` | `0.75rem` | Cards, buttons |
| `--radius-lg` | `1rem` | Modals, large panels |
| `--shadow` | `0 1px 3px rgba(15,23,42,0.08), 0 1px 2px -1px rgba(15,23,42,0.06)` | Subtle elevation |
| `--shadow-lg` | `0 10px 25px -8px rgba(15,23,42,0.15), 0 4px 10px -4px rgba(15,23,42,0.08)` | Cards, dropdowns |

### Forbidden aliases

These old names must not appear in any CSS. They map to the standard tokens:

| Old (banned) | Standard replacement |
|---|---|
| `--bg` | `--paper` |
| `--surface`, `--surface-2` | `--panel`, `--panel-alt` |
| `--border`, `--border-strong` | `--line`, `--line-strong` |
| `--glass`, `--glass-*` | `--panel-glass` + `backdrop-filter` for decorative glass; `--panel` for opaque cards |
| `--dock` | `--panel` |
| `--error` | `--danger` |

## 2. Typography

One font stack across all stores. No per-store font overrides.

```css
--font-body: 'Manrope', ui-sans-serif, system-ui, sans-serif;
--font-display: 'Fraunces', ui-serif, Georgia, serif;
--font-mono: ui-monospace, 'SF Mono', Menlo, monospace;
```

| Role | Font | Weights | Usage |
|------|------|---------|-------|
| Body text | Manrope | 400, 500, 600 | Paragraphs, nav, labels |
| Display / headings | Fraunces | 700, 800 | h1–h3, hero text |
| Code | System monospace | 400 | `<code>`, `<pre>` |

### Type scale (fixed)

Use Tailwind defaults (`text-sm`, `text-base`, `text-lg`, `text-xl`, `text-2xl`, etc.). No custom font-size values. No `clamp()` for body text (only for hero headings where viewport scaling is needed).

## 3. Dark mode

One mechanism: the `data-theme` attribute on `<html>`.

```
<html data-theme="dark">   ← dark
<html>                      ← light (default)
```

**Not** the `.dark` class. **Not** `prefers-color-scheme` media queries (those are read to determine the default, not to apply styles).

### Storage

All sites store the user's preference in the same localStorage key:

```
localStorage key: "stores-theme"
values: "light" | "dark" | "system"
```

One key across all stores so the preference follows the user.

### CSS selector

```css
:root { /* light tokens */ }
:root[data-theme="dark"] { /* dark tokens */ }
```

### Boot script (inline, before `</head>`)

```js
(function(){
  try {
    var p = localStorage.getItem('stores-theme');
    var dark = p === 'dark' || (!p || p === 'system') && matchMedia('(prefers-color-scheme: dark)').matches;
    if (dark) document.documentElement.dataset.theme = 'dark';
  } catch(e) {}
})();
```

## 4. Standard controls

Every page on every store must include these three controls in the header.

### Theme toggle

Button cycling: system → light → dark. Shows sun/moon icon. Writes to `localStorage('stores-theme')` and updates `data-theme` on `<html>`.

### Text size

Button cycling: default → large → small. Adds `data-text="lg"` or `data-text="sm"` on `<html>`. Stored in `localStorage('stores-text-size')`.

```css
:root { font-size: 16px; }
:root[data-text="lg"] { font-size: 18px; }
:root[data-text="sm"] { font-size: 14px; }
```

### Avatar / sign-in

- **Signed out:** "Sign in" link (text, not a button)
- **Signed in:** GitHub avatar (32px circle) that opens a dropdown (profile, billing if Pro, sign out, delete account)

## 5. Navbar structure

```
┌─────────────────────────────────────────────────────────────┐
│  [Brand mark]  Brand Name     Nav links...    [☀] [A] [👤] │
│                 tagline                                      │
└─────────────────────────────────────────────────────────────┘
```

| Zone | Contents | Varies per store? |
|------|----------|-------------------|
| Brand mark | SVG icon (40×40, rounded) | Yes — different icon per store |
| Brand name + tagline | Store name + short descriptor | Yes — "ProAppStore / Premium Web Apps" |
| Nav links | 4–7 links, left-aligned | Yes — different pages per store |
| Controls cluster | Theme toggle + Text size + Avatar/Sign-in | **No — identical everywhere** |

### Mobile (≤640px)

- Brand mark shrinks to 36px, tagline hidden
- Nav links collapse into a hamburger-triggered dropdown below the header, as shipped by the FAS and PAS SDKs, with opaque `--popover` background. A right-slide drawer is not required
- Controls cluster stays visible in header (no hamburger)

## 6. Tailwind 4 token mapping

Vendor this CSS mapping into each React UI's CSS entry point alongside its light
and dark token definitions. It replaces the Tailwind 3 JavaScript preset.
Use `@theme inline` so generated utilities reference live CSS variables and
`[data-theme]` switching works without rebuilding.

```css
@import "tailwindcss";
/* Add @source paths for SDK UI outside automatic source detection.
   Define the section 1 and 2 tokens in :root and :root[data-theme="dark"] here. */

@theme inline {
  --color-paper: var(--paper);
  --color-panel: var(--panel);
  --color-panel-alt: var(--panel-alt);
  --color-panel-glass: var(--panel-glass);
  --color-popover: var(--popover);
  --color-ink: var(--ink);
  --color-ink-strong: var(--ink-strong);
  --color-muted: var(--muted);
  --color-line: var(--line);
  --color-line-strong: var(--line-strong);
  --color-accent: var(--accent);
  --color-accent-hover: var(--accent-hover);
  --color-accent-soft: var(--accent-soft);
  --color-danger: var(--danger);
  --color-danger-soft: var(--danger-soft);
  --color-success: var(--success);
  --color-success-soft: var(--success-soft);
  --color-warning: var(--warning);
  --color-warning-soft: var(--warning-soft);
  --font-sans: var(--font-body);
  --font-serif: var(--font-display);
  --font-code: var(--font-mono);
  --radius-control: var(--radius-sm);
  --radius-card: var(--radius);
  --radius-dialog: var(--radius-lg);
  --shadow-surface: var(--shadow);
  --shadow-elevated: var(--shadow-lg);
}
```

Usage: `bg-panel text-ink border-line`, `bg-popover`, `bg-accent text-paper`,
`text-danger bg-danger-soft`, `rounded-card shadow-surface font-serif`.
Distinct font, radius and shadow mapping names avoid self-referencing variables.
Only use `bg-panel-glass backdrop-blur-md` for opt-in decorative glass.
Keep font sizing and spacing on Tailwind defaults. Explicit dark variants, if
needed beyond token switching, must target `[data-theme="dark"]`, never `.dark`
or a colour-scheme media query.

## 7. What varies per store (and nothing else)

| Allowed to vary | Example |
|---|---|
| `--accent`, `--accent-hover`, `--accent-soft` | Blue vs purple vs emerald |
| Brand mark SVG | Lightning bolt vs envelope vs gamepad |
| Brand name + tagline | "FreeAppStore / Trusted Web Apps" |
| Nav link items | Apps, Games, About, Pricing, Docs |
| OG image / favicon | Per-store icon |

**Everything else is identical.** Same fonts, same sizes, same spacing, same controls, same dark mode, same shadows, same radii.

## Enforcement

### 1. CI lint script (`check-design-system.sh`)

Runs in every store's CI pipeline. Fails the build on violations.

```bash
#!/bin/bash
set -euo pipefail

# Banned CSS variable names (old aliases)
BANNED='--bg[^-]|--surface|--border[^-]|--glass|--dock'
if grep -rn --include="*.css" --include="*.tsx" -E "$BANNED" src/ web/src/ style.css 2>/dev/null; then
  echo "FAIL: Found banned CSS variable names. Use standard tokens from DESIGN-SYSTEM.md"
  exit 1
fi

# Banned font-family declarations (must use variables)
if grep -rn --include="*.css" -E "font-family:\s*[^v]" src/ style.css 2>/dev/null | grep -v "var(--font" | grep -v "ui-monospace" | grep -v "currentColor"; then
  echo "FAIL: Hardcoded font-family. Use var(--font-body), var(--font-display), or var(--font-mono)"
  exit 1
fi

# Dark mode must use [data-theme], not .dark class
if grep -rn --include="*.css" "html\.dark\b" src/ style.css 2>/dev/null; then
  echo "FAIL: Found html.dark selector. Use :root[data-theme='dark'] instead"
  exit 1
fi

# Theme storage key must be 'stores-theme'
if grep -rn --include="*.js" --include="*.ts" --include="*.tsx" "localStorage.*\(.*theme" src/ web/src/ 2>/dev/null | grep -v "stores-theme"; then
  echo "FAIL: Theme localStorage key must be 'stores-theme'"
  exit 1
fi

echo "OK: Design system checks passed"
```

### 2. Vendored mapping and compliance checks

Copy section 6's Tailwind 4 `@theme inline` mapping into every React UI. Port
updates to each store independently under its delivery policy; no cross-store dependency.

Each store's `css-discipline` compliance check enforces banned aliases,
unlayered rules and hex outside token blocks. Apply it to SDK UI, console and
admin as well as apps. FAS uses `fas check` and `pnpm lint:platform-ui` in
its platform repository.

The `opaque-surface` rule requires `--paper`, `--panel` and `--popover`
to resolve to alpha = 1 in every theme, following variable references.
Any hex, rgba/hsla, colour mix or alias resolving to alpha below 1 violates the rule.
`--panel-glass` is the explicit exception and must be paired with `backdrop-filter`.
The shell lint above is a baseline, not a substitute for these compliance checks.
Stores may roll checks out as warnings before fleet migration; this does not
relax the surface contract.

### 3. PR review checklist

Every change touching CSS or UI components must answer:

- [ ] React UI uses Tailwind 4 on tokens; inline style only for dynamic values; no runtime-injected CSS
- [ ] Floating UI uses opaque `--popover`; `--paper` and `--panel` remain opaque in both themes
- [ ] Decorative glass uses `--panel-glass` with `backdrop-filter`
- [ ] Uses only standard CSS custom properties (no aliases)
- [ ] No hardcoded colors — uses `var(--accent)`, `var(--ink)`, etc.
- [ ] No custom font-family — uses `var(--font-*)` or Tailwind `font-*`
- [ ] Dark mode via `[data-theme="dark"]`, not `.dark`
- [ ] Standard controls present in header (theme, text size, avatar)

### 4. Migration plan

Current sites use the old variable names. Migration order:

1. **Console + Dashboard** — use `--panel-glass` with `backdrop-filter` for decorative glass, opaque `--panel` for cards and `--popover` for floating UI; add the section 6 mapping
2. **PAS store** — rename `--bg/--surface/--border` → `--paper/--panel/--line`, switch `.dark` → `[data-theme]`
3. **FAS store** — same renames
4. **FGS store** — same renames
5. Add lint script to each repo's CI
6. Add text-size control to all headers

Migrate each repo independently under its delivery policy. No big-bang refactor.

## Reference

- **BRAND.md** — accent colors, logo system, favicon delivery
- **PLATFORM-LAYOUT.md** — repo structure, vendor convention
- **SDK docs** — component API (`@proappstore/sdk/ui`, `@freeappstore/sdk/ui`)
