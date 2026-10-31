# ADR-001: Tailwind on FAS tokens

## Status

Accepted - 2026-10-31. Implements #320, child of #318.
Adapted from [PAS ADR-011](https://github.com/proappstore-online/platform/blob/main/docs/adr/011-tailwind-on-pas-tokens.md).

## Context

Listing the app stack did not establish a styling rule for platform UI. The SDK
acquired a separate injected-CSS convention while inline styles and long-hand
token utilities spread across SDK, console and admin. One shared rule must
preserve theme switching and app branding on every surface.

## Decision

React + Tailwind 4 on FAS tokens is **required for every React surface**:
apps, templates, `packages/sdk/src/ui`, `sites/console`, and `workers/admin`.
The SDK is not exempt. Use these three layers in order of preference:

1. Reuse `@freeappstore/sdk/ui` or app-local React components for repeated UI
   such as buttons, cards, inputs, dialogs and empty states.
2. Write Tailwind utilities on token colours in `className`, such as
   `text-ink bg-panel border-line`, for layout and one-offs. Map the tokens
   with `@theme inline`; prefer named utilities to `text-[var(--muted)]`.
3. Keep `web/src/index.css` (or the surface's entry stylesheet) limited to
   `@import "tailwindcss"`, `@source`, token blocks (`:root` and
   `:root[data-theme='dark']`), `@theme`, and `@layer base` /
   `@layer components`. Print styles may use `@media print`.
   No unlayered rules or hex colours outside token blocks.

Never add feature classes to index.css; extract a React component instead.
Never inline `style` except for truly dynamic values such as computed positions,
transforms and progress widths; comment the reason. Static appearance uses
utilities or component variants. Runtime-injected CSS strings are prohibited,
including in the SDK.

Branding stays in token values in the light and dark token blocks. Migration
changes how tokens are used, not an app's palette. The [styling guide](../ui.md#styling)
contains the mapping and explicit SDK distribution `@source` entries needed
because Tailwind skips dependencies under `node_modules`.

Menus, drawers, popovers, modals and toasts use an opaque surface in both themes:
`bg-popover` with `--popover: var(--paper)`, or `bg-paper`. Do not apply opacity
to the container. Reserve `--panel-glass` for explicit glass effects and
`--scrim` for translucent backdrops.

## Alternatives considered

- Optional Tailwind or a separate SDK convention permits conflicting instructions
  and continued growth of global CSS and inline styles.
- CSS modules require another stylesheet and naming convention per component.
- Another component library adds its own theme system and bundle cost; reuse SDK
  and local React components on FAS tokens instead.

## Consequences

The ADR, UI reference, public platform guide and repository instructions share
one styling model. Theme switching and branding flow through token values.
Existing surfaces need migration; this decision does not claim legacy code
already complies. Migration and broader mechanical enforcement belong to #318.
The existing design-system lint checks token aliases and theme conventions.
