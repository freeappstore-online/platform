# UI Components

See [DESIGN-SYSTEM.md](https://github.com/freeappstore-online/platform/blob/main/DESIGN-SYSTEM.md) for the storefront styling and surface
contract, including opaque floating UI and opt-in glass.

Drop-in React components from `@freeappstore/sdk/ui`. Components use CSS custom properties (`--ink`, `--accent`, etc.) to blend into your app's theme.

```tsx
import {
  // App shell (start here)
  Shell, PageHeader, useToast, useDocumentTitle, useOnline, NavBar,
  ProfileMenu, ProfilePage, AccountSection,
  ToastProvider, ShellErrorBoundary, SkipLink, useRouteChangeEffects,
  routeUrl, routeHref, canFollowLink, profileReturnHref, useCurrentLocation, isLocalRoute,
  // Auth & identity
  Avatar, SignInButton,
  // Controls
  ThemeToggle, TextSizeToggle,
  // Friends
  AddFriendButton, FriendRequestBadge, FriendsList,
  // Voice
  VoiceButton, VoiceTextArea,
  // Feedback
  Spinner, Badge, ProgressBar, EmptyState, ErrorBoundary,
  // Data display
  Card, ListRow, Tabs,
  // Overlays
  Modal, ConfirmDialog,
  // Input
  SearchInput,
  // API keys
  KeyPrompt,
  // Info
  BuildInfo, Footer,
} from '@freeappstore/sdk/ui';
```

## Shell: the standard app frame

`Shell` is the supported default frame. It stays put while screens change
inside it: topbar, primary navigation, error handling, toasts and an offline
banner. New apps from VibeCode and `fas init` start inside it. A custom frame,
sidebar, bottom nav, or detail route is allowed when it keeps the
[composable starter contract](composable-starter-contract.md).

```tsx
import { initApp } from '@freeappstore/sdk';
import { type NavItem, PageHeader, Shell } from '@freeappstore/sdk/ui';

const fas = initApp({ appId: 'my-app' });

const NAV: NavItem[] = [
  { label: 'Notes', href: '/', title: 'Notes' },
  { label: 'Tags', href: '/tags', title: 'Tags — Notes' },
];

export default function App() {
  return (
    <Shell app={fas} appName="Notes" nav={NAV}>
      {location.pathname === '/tags' ? <TagsScreen /> : <NotesScreen />}
    </Shell>
  );
}

function TagsScreen() {
  return <PageHeader title="Tags" description="Group your notes." />;
}
```

What you get, with nothing to enable:

| Part | What it does |
|------|--------------|
| **Topbar** | `<header>` with your app name, text-size toggle, theme toggle, and a 44px avatar link to Profile in both auth states. On the built-in Profile page, the avatar position becomes a 24px X close link. |
| **Main navigation** | From `nav`: a `<nav aria-label="Main">` in the topbar, the current screen marked `aria-current="page"` (`/tags/42` marks `/tags`), a menu button below 640px (Escape or a click outside closes it), 44px targets and visible focus. |
| **`<main id="main">`** | Your screens render here. |
| **Error boundary** | A screen that throws while rendering shows **Try again** instead of a white page; the topbar stays. The error is recorded in `fas.log` (category `react.error-boundary`). Moving to another screen clears it. |
| **Loading** | A `<Suspense>` spinner while a `React.lazy` screen loads. |
| **Toasts** | One polite live region. `useToast().show(message, { variant, duration })`. |
| **Offline banner** | Shown under the topbar while the connection is down; announced, dismissible, cleared on reconnect. `useOnline()` gives screens the same signal. |
| **Tab titles** | A `title` on a nav item becomes the tab title on its route; `useDocumentTitle()` in a screen overrides it. |
| **Skip link** | "Skip to content", the first focusable element, hidden until focused. |
| **Route changes** | With `onNavigate`: forward navigation follows a fragment target or scrolls to the top; back/forward restores the position. Without a fragment, focus moves to the screen's `PageHeader` (else `<main>`). |
| **Bottom safe area** | Padding for the home indicator, without a platform attribution bar in browser or installed mode. |

FreeAppStore is free, so there is no subscription or upgrade screen: the only
gate is the optional sign-in gate.

### Props

| Prop | Description |
|------|-------------|
| `app` | The `initApp()` instance. Required. |
| `appName` | Shown in the topbar. |
| `nav` | The app's screens: `{ label, href, icon?, title? }[]`. No `nav` (or an empty list): no navbar. |
| `onNavigate(href)` | Client-side navigation for nav clicks, e.g. `history.pushState` + your route state, or a router's `navigate`. Without it, nav items are ordinary links (the host serves your app for any path). |
| `renderNav({ items, currentPath, onNavigate })` | Replace the built-in navbar; the result still goes in the topbar. Render a `<nav aria-label="Main">`. |
| `headerActions` | Header control slot, rendered beside the profile control inside `[data-fas-header-actions]`. App buttons go here. The avatar links to Profile in both auth states; on the built-in Profile page, that slot shows a 24px X close link in the same 44px target, with accessible name `Close profile`. App-owned `profileHref` pages keep their own header and navigation behavior. |
| `profileHref` | Optional app-owned profile route, e.g. `/account`, accessible in both auth states. Omit to use the built-in `/profile` page with GitHub/Google sign-in choices and account management. Avatar clicks navigate using `onNavigate` when supplied; modified clicks retain native behavior. A custom profile route must render its own signed-out and signed-in UI. |
| `requireAuth` | Protect app content until sign-in; the topbar and profile route remain accessible. Default `false`. |
| `showThemeToggle` | Default `true`. The topbar shows it while signed out. `ProfilePage` shows it while signed in. |
| `renderError({ error, reset })` | Replace the error fallback. |
| `renderLoading()` | Replace the loading spinner. |

### Screens

- **Primary navigation defaults to `nav`.** Detail routes do not need their own
  nav item. A custom frame, sidebar, or bottom nav is allowed under the
  [composable starter contract](composable-starter-contract.md). Keep a labelled
  navigation landmark, keyboard access, and visible focus.
- **Start each primary screen with `PageHeader`.** `<PageHeader title description? actions? />`
  renders the screen's single `<h1>`, and it is where focus lands after navigation.
- **Raise feedback with `useToast`.** `Shell` provides it. A custom frame mounts `ToastProvider`.

```tsx
function NoteScreen({ note }: { note: Note }) {
  useDocumentTitle(`${note.title} — Notes`);
  const toast = useToast();
  return (
    <PageHeader
      title={note.title}
      actions={<button onClick={() => { save(note); toast.show('Saved', { variant: 'success' }); }}>Save</button>}
    />
  );
}
```

With client-side routing, pass `onNavigate` so nav clicks don't reload the page:

```tsx
const [path, setPath] = useState(location.pathname);
useEffect(() => {
  const sync = () => setPath(location.pathname);
  addEventListener('popstate', sync);
  return () => removeEventListener('popstate', sync);
}, []);

<Shell app={fas} appName="Notes" nav={NAV} onNavigate={(href) => { history.pushState(null, '', href); setPath(window.location.pathname); }}>
  {path === '/tags' ? <TagsScreen /> : <NotesScreen />}
</Shell>
```

`FasShell` is the same component under its older name, and apps that don't use
`Shell` are unaffected by any of this. `NavBar` and `activeHref` are exported for
custom layouts. A sidebar, bottom nav, or focused canvas should compose the
exported providers instead of patching Shell's DOM. See
[Migrating from DOM overrides](#migrating-from-dom-overrides).

### Migrating to the Shell

Older apps and older copies of this guide used a hand-rolled layout. These steps
move an app onto the supported default. They are not a ban on a custom frame.
To move an app onto the standard frame:

1. **Update the SDK** to `@freeappstore/sdk@^0.14.30` or later. That is the first
   release with `nav`, `PageHeader`, `useToast` and the resilience layer.
2. **Delete the local layout.** Remove `web/src/components/Shell.tsx` (the old
   sidebar + bottom-dock template component) or any hand-built header, sidebar, tab
   bar or dock, and render `<Shell app={fas} appName="…" nav={NAV}>` from
   `@freeappstore/sdk/ui` as the root of `App.tsx`.
3. **Move navigation into `nav`.** Every link that was in the sidebar or dock becomes
   a `{ label, href, title? }` entry. Remove navigation from inside screens.
4. **Give each screen a `PageHeader`** in place of its own `<h1>`.
5. **Drop your own error boundary and loading wrapper** around the app; the Shell
   has both. Replace ad-hoc "Saved!" banners with `useToast()`.
6. **Theme CSS:** key dark mode off `:root[data-theme="dark"]` (see
   [Theming](#theming)). A stylesheet that only uses `@media (prefers-color-scheme: dark)`
   ignores the Shell's theme toggle.
7. **Already on `FasShell`?** It is the same component. Add `nav` (and `onNavigate`
   if you route client-side), and remove `requireAuth` unless the whole app needs
   sign-in.

### Migrating from DOM overrides

Some apps reached into the Shell DOM because the frame had no place for their own
controls. One rewrote header buttons on a timer. Another styled internal Shell
nodes. Those overrides break on the next SDK release. Delete the timer, the
`querySelector` pass, and the CSS that depends on Shell's private markup, and use
the extension points below.

**Stay on Shell and add header controls.** `headerActions` is the header control
slot. It renders in the topbar beside the profile avatar, inside
`[data-fas-header-actions]`. The avatar still opens the profile in both auth
states and never starts sign-in. `renderNav` still replaces only the navbar.

```tsx
<Shell
  app={fas}
  appName="Notes"
  nav={NAV}
  headerActions={<button type="button" onClick={createNote}>New</button>}
>
  <PageHeader title="Notes" />
</Shell>
```

**Compose a custom frame** for a sidebar, a bottom nav, or a focused canvas. Do
not mount a second `Shell` around it. Keep one `header` and one `main`. A detail
screen does not need its own nav item. Wrap the tree in the same pieces `Shell`
uses:

- `ToastProvider` and `useToast` for feedback. `Shell` already includes the provider.
- `ShellErrorBoundary` with `app` and `resetKey` set to the current route, for render errors.
- `SkipLink` plus `<main id="main" tabIndex={-1}>`.
- `useRouteChangeEffects(location, mainRef, true)` for focus and scroll on client-side moves.
- `AccountSection` for identity. Signed out, it offers GitHub and Google and an avatar link to the profile. Signed in, the avatar and name link to the profile. Pass `children` for app-specific settings. The avatar never calls sign-in.
- `ProfilePage` accepts `children` after its built-in account sections when the app keeps the built-in profile route.
- `Footer` stays the opt-in attribution. Neither `Shell` nor `AccountSection` mounts it.

**Router integration.** Pass the router's navigate function as `onNavigate` on
`Shell`, `NavBar`, or `AccountSection`. Keep pathname, query, and hash: give the
router `routeHref(routeUrl(href))`, not the pathname alone. `canFollowLink` leaves
modified clicks, downloads, external URLs, and other windows to the browser.
`profileReturnHref` reads a safe in-app `returnTo`. `useCurrentLocation` follows
back and forward. `isLocalRoute` tells an in-app destination from an off-site one.
These helpers work with an existing history router. They do not replace it.

```tsx
function navigate(href: string) {
  const destination = routeUrl(href);
  if (!destination || !isLocalRoute(destination)) {
    window.location.assign(href);
    return;
  }
  history.pushState(null, '', routeHref(destination));
}
```

A focused canvas may set `touch-none` on that canvas. Do not set `user-scalable=no`
or `maximum-scale` on the document.

`ProfileMenu` stays exported for older menus. New code uses the profile link and
`AccountSection`.

### Caveats

- **The avatar always opens a profile page.** It never starts OAuth or opens a dropdown.
  The built-in `/profile` route renders `ProfilePage`, with GitHub and Google
  `SignInButton`s when signed out and account/preferences actions when signed in.
  The header avatar slot becomes the `Close profile` link and the separate
  **Back to app** row is omitted. Closing follows the safe in-app `returnTo`
  destination, including its query and fragment; direct, invalid, off-site and
  profile-loop entries fall back to `/`.
  `Shell` does not mount `SignInButton` or `ProfileMenu` in the header.
  It supports direct links, reloads and back/forward.
  `requireAuth` protects app content while keeping the frame and profile page accessible.
  Apps that own `/profile` already should pass `profileHref="/profile"` and render their own page.
- **The error boundary catches render errors only.** Errors thrown in event handlers
  or async code are not caught by React; handle them there (for example
  `catch (e) { toast.show('Could not save', { variant: 'error' }) }`). Caught render
  errors are kept in `fas.log` and uploaded only for signed-in users.
- **`useToast` needs `Shell` or `ToastProvider`.** `Shell` includes the provider.
  A custom frame mounts `ToastProvider` itself. With neither, `useToast` throws
  `useToast must be used inside <Shell> or <ToastProvider>`.
- **Navigation and focus.** Profile and navigation links use `onNavigate` for client-side
  routing and deterministic in-app scroll restoration. Route state includes query strings and
  fragments, even when the pathname stays the same. Relative in-app destinations are resolved
  before the router runs; external destinations, modified clicks, downloads and links targeting
  another window retain native browser behavior. `renderNav` receives the full URL path in
  `currentPath`. Without `onNavigate`, links are normal links and
  the browser manages navigation and scroll restoration; full reloads of asynchronously rendered
  screens may not recover the exact scroll position. The built-in profile remembers the originating in-app URL in `returnTo`, so
  **Close profile** keeps the original path, query and fragment through reload and sign-in;
  off-site return destinations and loops back to the profile are rejected. Query-only and
  fragment-only history changes update the shell too. External links, downloads, and links targeting
  another window retain native browser behavior even with `onNavigate`. The host serves your app's `index.html`
  for any path without a file extension, so deep links like `/tags` work on reload.
- **The Shell does not load fonts or tokens.** They come from your app's `index.css`
  (the templates include them).
- **`<main id="main">` belongs to the Shell.** Don't reuse `id="main"` in a screen;
  the skip link targets it.
- **Brief loading screen.** The Shell renders "Loading…" until auth has initialised,
  which is immediate unless the page is returning from sign-in.

## Auth & Identity

| Component | Props | Description |
|-----------|-------|-------------|
| `Avatar` | `user`, `size` | GitHub avatar with fallback |
| `SignInButton` | `app`, `label`, `provider`, `compactOnMobile` | Provider button used on `ProfilePage` (GitHub and Google). Not mounted in the Shell header. `compactOnMobile` is for a custom layout that wants an icon below the medium breakpoint |

## Controls

| Component | Props | Description |
|-----------|-------|-------------|
| `ThemeToggle` | -- | Light/dark mode toggle |
| `TextSizeToggle` | -- | Text size accessibility toggle |

## Layout & Navigation

| Component | Props | Description |
|-----------|-------|-------------|
| `Shell` | see [Shell](#shell-the-standard-app-frame) | The app frame: topbar, main navigation, error boundary, toasts |
| `NavBar` | `items`, `currentPath?`, `onNavigate?` | The navbar `Shell` renders from `nav`, for custom layouts |
| `PageHeader` | `title`, `description?`, `actions?` | A screen's single `<h1>` |
| `AccountSection` | `app`, `profileHref?`, `onNavigate?`, `location?`, `children?` | Embeddable account block. GitHub and Google when signed out. Avatar and name link to the profile in both auth states. `children` is app-specific settings. |
| `ProfileMenu` | `app`, `showThemeToggle?`, `children?` | Legacy dropdown with profile, settings, sign out, and deletion feedback; Shell uses the separate Profile page |
| `ProfilePage` | `app`, `showThemeToggle?`, `children?` | Full profile page. `children` render after the built-in account sections. |
| `ToastProvider` | `children` | Toast queue for a custom frame. `Shell` already includes one. |
| `ShellErrorBoundary` | `app`, `resetKey`, `renderError?` | Render-error boundary `Shell` uses around the screen. |
| `SkipLink` | `mainRef` | Skip link targeting `<main id="main">`. |
| `Tabs` | `tabs`, `active`, `onChange` | Tab navigation |

## Friends

| Component | Props | Description |
|-----------|-------|-------------|
| `AddFriendButton` | `app`, `userId` | Send friend request button |
| `FriendRequestBadge` | `app` | Badge showing pending friend request count |
| `FriendsList` | `app` | Full friends list with status |

## Voice

| Component | Props | Description |
|-----------|-------|-------------|
| `VoiceButton` | `onResult` | Push-to-talk voice input button |
| `VoiceTextArea` | `value`, `onChange`, `onVoiceResult` | Text area with integrated voice input |

## Feedback

| Component | Props | Description |
|-----------|-------|-------------|
| `Spinner` | `size` | Loading spinner |
| `Badge` | `variant` (`success`, `warning`, `danger`, `info`) | Status badge |
| `ProgressBar` | `value`, `label` | Progress indicator |
| `EmptyState` | `message` | Placeholder for empty lists |
| `ErrorBoundary` | `children` | React error boundary with fallback UI (`Shell` already has one around your screens) |

## Data Display

| Component | Props | Description |
|-----------|-------|-------------|
| `Card` | `onClick` | Clickable card container |
| `ListRow` | `title`, `subtitle`, `onClick` | List item row |

## Overlays

| Component | Props | Description |
|-----------|-------|-------------|
| `Modal` | `open`, `onClose`, `title`, `ariaLabel`, `closeOnEscape` | Accessible modal dialog: `role="dialog"` + `aria-modal`, named by `title` (or `ariaLabel`); focus moves in on open (`data-autofocus`, else the first control), Tab stays inside, Esc closes, focus returns to the opener |
| `ConfirmDialog` | `open`, `onConfirm`, `onCancel`, `title`, `message`, `confirmLabel`, `variant`, `closeOnEscape` | Confirmation dialog (a `Modal`); focus starts on Cancel, Esc cancels |

## Input

| Component | Props | Description |
|-----------|-------|-------------|
| `SearchInput` | `value`, `onChange` | Search field with icon |

## API Keys

| Component | Props | Description |
|-----------|-------|-------------|
| `KeyPrompt` | `app`, `provider`, `providerName` | Prompts user to configure an API key |

## Info

| Component | Props | Description |
|-----------|-------|-------------|
| `BuildInfo` | -- | Shows SDK version and build metadata |
| `Footer` | `text` | Optional store attribution footer for installed apps; never added by `Shell` |

## Hooks (from `@freeappstore/sdk/ui`)

| Hook | Returns | Description |
|------|---------|-------------|
| `useToast` | `{ show, dismiss }` | Raise a toast in the `Shell`'s live region |
| `useDocumentTitle` | -- | Set the tab title for the current screen |
| `useOnline` | `boolean` | Whether the browser is online |
| `useTextSize` | `{ size, setSize }` | Text size preference |
| `useStandalone` | `boolean` | Detects PWA standalone mode |

Theme and text-size preferences are shared by the topbar, Profile page, and custom
controls. Changes also synchronize across tabs on the same origin. When storage is
blocked, choices still apply for the current page session; persistence across reloads
requires working local storage. Templates provide the CSS tokens and font-size rules.

## Theming

All components respect the platform design system tokens. Override accent color:

```css
:root {
  --accent: #10b981;
}
```

The tokens and brand fonts (Manrope + Fraunces) come from your app's `index.css`,
which the templates set up. Dark mode keys off `:root[data-theme="dark"]`: the SDK
sets it from the system preference or the `Shell`'s theme toggle.

```css
:root[data-theme="dark"] {
  color-scheme: dark;
  --paper: #0f0f0f;
  --ink: #f5f5f5;
  /* …the rest of your dark tokens */
}
```

## Styling

React + Tailwind 4 on FAS tokens is **required for every React surface**:
apps, templates, `packages/sdk/src/ui`, `sites/console`, and `workers/admin`.
[ADR-001](https://github.com/freeappstore-online/platform/blob/main/docs/adr/001-tailwind-on-fas-tokens.md) defines three layers:

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
changes how tokens are used, not an app's palette. The configuration below
contains the token mapping and explicit SDK distribution `@source` entries needed
because Tailwind skips dependencies under `node_modules`.

Menus, drawers, popovers, modals and toasts use an opaque surface in both themes:
`bg-popover` with `--popover: var(--paper)`, or `bg-paper`. Do not apply opacity
to the container. Reserve `--panel-glass` for explicit glass effects and
`--scrim` for translucent backdrops.

Both [template-standalone](https://github.com/freeappstore-online/template-standalone)
and [template-connected](https://github.com/freeappstore-online/template-connected)
ship this configuration with SDK 0.16.0 or later. From either template root,
run `pnpm install --frozen-lockfile` and `pnpm test`. The tests build the app
and check emitted app/SDK utilities, drawer animation CSS, and opaque light/dark
surface tokens. CI runs these checks on pushes to `main` and pull requests.
The SDK source path is relative to `web/src/index.css`: `../node_modules`
resolves to `web/node_modules`; `../../node_modules` also covers root installs.

| Token | Utilities via `@theme inline` |
|-------|--------------------------------|
| `--paper`, `--paper-deep` | `bg-paper`, `bg-paper-deep` |
| `--ink`, `--ink-strong`, `--muted` | `text-ink`, `text-ink-strong`, `text-muted` |
| `--line`, `--line-strong` | `border-line`, `border-line-strong` |
| `--panel`, `--popover` | `bg-panel`, `bg-popover` |
| `--accent`, `--accent-soft`, `--accent-deep`, `--accent-hover` | `text-accent`, `bg-accent-soft`, `text-accent-deep`, `hover:bg-accent-hover` |
| `--sky`, `--mint` (and soft/deep variants) | `text-sky`, `bg-sky-soft`, `text-mint-deep` |
| `--success`, `--warning`, `--danger` (and soft variants) | `text-success`, `text-warning`, `text-danger`, `bg-danger-soft` |
| `--panel-glass`, `--scrim` | `bg-panel-glass`, `bg-scrim` |

SDK 0.16.0 no longer injects styles. Existing apps must add the following to
`web/src/index.css` after the Tailwind import before upgrading. Tailwind skips
`node_modules` by default. The first source is relative to `web/src` when the
dependency is installed under `web/node_modules`; the second supports a hoisted
root install. These are the same explicit SDK-distribution sources used by PAS.

```css
@import "tailwindcss";
@source "../node_modules/@freeappstore/sdk/dist";
@source "../../node_modules/@freeappstore/sdk/dist";

@theme inline {
  --color-paper: var(--paper);
  --color-paper-deep: var(--paper-deep);
  --color-ink: var(--ink);
  --color-ink-strong: var(--ink-strong);
  --color-muted: var(--muted);
  --color-line: var(--line);
  --color-line-strong: var(--line-strong);
  --color-panel: var(--panel);
  --color-panel-glass: var(--panel-glass);
  --color-popover: var(--popover);
  --color-accent: var(--accent);
  --color-accent-soft: var(--accent-soft);
  --color-accent-deep: var(--accent-deep);
  --color-accent-hover: var(--accent-hover);
  --color-sky: var(--sky);
  --color-sky-soft: var(--sky-soft);
  --color-sky-deep: var(--sky-deep);
  --color-mint: var(--mint);
  --color-mint-soft: var(--mint-soft);
  --color-mint-deep: var(--mint-deep);
  --color-success: var(--success);
  --color-success-soft: var(--success-soft);
  --color-warning: var(--warning);
  --color-warning-soft: var(--warning-soft);
  --color-danger: var(--danger);
  --color-danger-soft: var(--danger-soft);
  --color-scrim: var(--scrim);
  --radius: var(--radius);
  --radius-sm: var(--radius-sm);
  --radius-lg: var(--radius-lg, var(--radius));
  --shadow-sm: var(--shadow);
  --shadow-lg: var(--shadow-lg, var(--shadow));
}

@theme {
  --animate-sdk-fade-in: sdk-fade-in 150ms ease-out;
  --animate-sdk-slide-up: sdk-slide-up 200ms ease-out;
  --animate-sdk-drawer: sdk-drawer 200ms ease-out;
  @keyframes sdk-fade-in { from { opacity: 0; } to { opacity: 1; } }
  @keyframes sdk-slide-up {
    from { opacity: 0; transform: translateY(8px); }
    to { opacity: 1; transform: translateY(0); }
  }
  @keyframes sdk-drawer {
    from { transform: translateX(100%); }
    to { transform: translateX(0); }
  }
}
```

Define the underlying tokens in `:root` and override their values in
`:root[data-theme='dark']`. The `inline` mapping keeps theme switching live.
`--paper`, `--panel` and `--popover` must be opaque in both themes.
Set `--popover: var(--paper)` for menus, mobile drawers, dialogs and toasts.
Glass is opt-in: use `--panel-glass` with backdrop blur. Set `--scrim` for the
translucent modal backdrop and define `--success-soft`, `--warning-soft` and
`--danger-soft` (for example with `color-mix(in srgb, var(--danger) 15%, var(--paper))`).
The templates include these mappings and animation keyframes. Animations respect
reduced motion. Mobile navigation uses a right-slide panel below the header,
with Escape, outside-click dismissal and focus return to the menu button.

### Migrate an existing app to token utilities

Run `fas migrate tailwind-tokens --dir <app-repo>` to preview a unified diff and per-file counts. Add `--write` to apply it. The command scans `web/src`, adds missing Tailwind theme mappings for defined FAS tokens, and rewrites class attributes and `cn`/`clsx`/`classnames` calls while preserving variants and opacity. Radius and shadow mappings use `rounded-fas`, `rounded-fas-sm`, and `shadow-fas`.

Banned aliases are resolved from the app's own CSS; conflicting light/dark definitions, cycles, and unknown tokens are left in place and reported. Review the remaining CSS rules, hex colours, dark overrides, and inline-style counts in the report. Run the app build after applying the migration. Re-running the command is a no-op once migrated. This command does not convert static inline styles or add SDK `@source` directives.

The default `ProfilePage` also offers app installation when the shared PWA controller
has a browser install offer (SDK >=0.16.37). It works in both auth states; see
[PWA installation](pwa-lifecycle.md#installation-in-profile) for custom frame APIs.

## Editable forms

Compose the existing Modal with labelled native controls. This optional example uses
an app-owned item and save callback; adapt the fields and validation to the product.
Mount one editing session at a time so reopening uses current data. A pending save
blocks duplicate submission and closing; a rejected write preserves the draft and
returns focus to the input. Unread/initially loading data belongs in the parent screen's
loading/error state before opening an editor.

```tsx
import { type FormEvent, useEffect, useId, useRef, useState } from 'react';
import { Modal } from '@freeappstore/sdk/ui';

export type Item = { id: string; name: string };
type EditorProps = { item: Item; onSave(item: Item): Promise<void> };

export function EditItemButton({ item, onSave }: EditorProps) {
  const [open, setOpen] = useState(false);
  return <>
    <button type="button" className="min-h-11 rounded border border-line px-3 py-2"
      onClick={() => setOpen(true)}>Edit {item.name}</button>
    {open && <ItemForm key={item.id} item={item} onSave={onSave} onClose={() => setOpen(false)} />}
  </>;
}

// Mount per editing session: reopening starts with the current item, not a stale draft.
function ItemForm({ item, onSave, onClose }: EditorProps & { onClose(): void }) {
  const nameId = useId();
  const errorId = useId();
  const input = useRef<HTMLInputElement>(null);
  const saving = useRef(false);
  const [name, setName] = useState(item.name);
  const [invalid, setInvalid] = useState(false);
  const [error, setError] = useState('');
  const [pending, setPending] = useState(false);
  useEffect(() => { if (error && !pending) input.current?.focus(); }, [error, pending]);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (saving.current) return;
    const nextName = name.trim();
    if (!nextName) { setInvalid(true); setError('Enter a name.'); return; }
    setInvalid(false);
    setError('');
    saving.current = true;
    setPending(true);
    try {
      // The app owns persistence. Throw on a failed SDK result; do not discard it.
      await onSave({ ...item, name: nextName });
      onClose();
    } catch {
      setError('Could not save. Your changes are still here.');
    } finally {
      saving.current = false;
      setPending(false);
    }
  }

  return <Modal open title="Edit item" onClose={() => { if (!saving.current) onClose(); }}>
    <form noValidate onSubmit={submit} className="flex min-w-0 flex-col gap-3">
      <label htmlFor={nameId} className="font-semibold">Name</label>
      <input ref={input} id={nameId} data-autofocus value={name} disabled={pending}
        aria-invalid={invalid} aria-describedby={error ? errorId : undefined}
        onChange={event => { setName(event.target.value); setInvalid(false); setError(''); }}
        className="min-h-11 w-full min-w-0 rounded border border-line bg-paper p-3 text-ink" />
      {error && <p id={errorId} role="alert">{error}</p>}
      {pending && <p role="status">Saving…</p>}
      <div className="flex flex-wrap gap-3">
        <button type="button" disabled={pending} onClick={onClose}
          className="min-h-11 rounded border border-line px-3 py-2">Cancel</button>
        <button type="submit" disabled={pending}
          className="min-h-11 rounded bg-accent px-3 py-2 text-white">Save</button>
      </div>
    </form>
  </Modal>;
}
```

When adapting `onSave` to an SDK helper, check `result.ok` and throw on failure. A resolved
promise containing a failed result is not a successful save. Validate the complete
value: reject an all-whitespace name, and define numeric/date boundaries in the app.
For example, `parseFloat('40junk')` silently accepts part of the input; it is insufficient
validation. This example adds no form library, schema or persistence capability.
Use app-owned navigation/PWA guards if the product needs to preserve unsaved drafts
outside the dialog. Test actual sequential typing, Enter, Tab/Shift-Tab, Escape, failed
writes and narrow screens with enlarged text.
