# UI Components

Drop-in React components from `@freeappstore/sdk/ui`. Components use CSS custom properties (`--ink`, `--accent`, etc.) to blend into your app's theme.

```tsx
import {
  // App shell (start here)
  Shell, PageHeader, useToast, useDocumentTitle, useOnline, NavBar,
  ProfileMenu, ProfilePage,
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

Every FreeAppStore app wraps itself in `Shell`. It is the frame that stays put
while screens change inside it, so apps don't build their own header, navigation
or error handling. New apps from VibeCode and `fas init` start inside it.

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
| **Topbar** | `<header>` with the FreeAppStore link, your app name, text-size toggle, theme toggle, and sign-in button or profile menu. |
| **Main navigation** | From `nav`: a `<nav aria-label="Main">` in the topbar, the current screen marked `aria-current="page"` (`/tags/42` marks `/tags`), a menu button below 640px (Escape or a click outside closes it), 44px targets and visible focus. |
| **`<main id="main">`** | Your screens render here. |
| **Error boundary** | A screen that throws while rendering shows **Try again** instead of a white page; the topbar stays. The error is recorded in `fas.log` (category `react.error-boundary`). Moving to another screen clears it. |
| **Loading** | A `<Suspense>` spinner while a `React.lazy` screen loads. |
| **Toasts** | One polite live region. `useToast().show(message, { variant, duration })`. |
| **Offline banner** | Shown under the topbar while the connection is down; announced, dismissible, cleared on reconnect. `useOnline()` gives screens the same signal. |
| **Tab titles** | A `title` on a nav item becomes the tab title on its route; `useDocumentTitle()` in a screen overrides it. |
| **Skip link** | "Skip to content", the first focusable element, hidden until focused. |
| **Route changes** | With `onNavigate`: forward navigation scrolls to the top, back/forward restores the position, and focus moves to the new screen's `PageHeader` (else `<main>`). |

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
| `requireAuth` | Show a sign-in screen instead of the app until the user signs in. Default `false`. |
| `showThemeToggle` | Default `true`. |
| `renderError({ error, reset })` | Replace the error fallback. |
| `renderLoading()` | Replace the loading spinner. |

### Screens

- **Navigation lives in `nav`.** Don't build a header, sidebar, tab bar or
  bottom dock, and don't put navigation inside a screen.
- **Start each screen with `PageHeader`.** `<PageHeader title description? actions? />`
  renders the screen's single `<h1>`, and it is where focus lands after navigation.
- **Raise feedback with `useToast`.** It must be called inside `Shell`.

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

<Shell app={fas} appName="Notes" nav={NAV} onNavigate={(href) => { history.pushState(null, '', href); setPath(href); }}>
  {path === '/tags' ? <TagsScreen /> : <NotesScreen />}
</Shell>
```

`FasShell` is the same component under its older name, and apps that don't use
`Shell` are unaffected by any of this. `NavBar` and `activeHref` are exported for
custom layouts.

### Migrating to the Shell

Older apps and older copies of this guide used a hand-rolled layout. To move an app
onto the standard frame:

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

### Caveats

- **Sign-in is optional.** Signed-out visitors see a "Sign in" button in the topbar
  even in apps that only use localStorage; that is expected. `requireAuth` hides the
  whole app, navigation included, behind a sign-in screen.
- **The error boundary catches render errors only.** Errors thrown in event handlers
  or async code are not caught by React; handle them there (for example
  `catch (e) { toast.show('Could not save', { variant: 'error' }) }`). Caught render
  errors are kept in `fas.log` and uploaded only for signed-in users.
- **`useToast` works only inside `Shell`.** Outside it throws
  `useToast must be used inside <Shell>`.
- **Scroll and focus handling needs `onNavigate`.** Without it every nav click is a
  full page load, which the browser handles. The host serves your app's `index.html`
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
| `SignInButton` | `app` | Sign in with GitHub button |

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
| `ProfileMenu` | `app`, `user` | Dropdown with profile, settings, sign out |
| `ProfilePage` | `app` | Full profile page with account management |
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
| `Modal` | `open`, `onClose`, `title` | Modal dialog |
| `ConfirmDialog` | `open`, `onConfirm`, `onCancel`, `title`, `message`, `variant` | Confirmation dialog |

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
| `Footer` | -- | Standard platform footer |

## Hooks (from `@freeappstore/sdk/ui`)

| Hook | Returns | Description |
|------|---------|-------------|
| `useToast` | `{ show, dismiss }` | Raise a toast in the `Shell`'s live region |
| `useDocumentTitle` | -- | Set the tab title for the current screen |
| `useOnline` | `boolean` | Whether the browser is online |
| `useTextSize` | `{ size, setSize }` | Text size preference |
| `useStandalone` | `boolean` | Detects PWA standalone mode |

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
