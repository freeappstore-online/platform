# Getting Started

Scaffold a free app, develop it locally, then publish it with the CLI.

## Prerequisites

- Node.js 22+
- pnpm (recommended) or npm
- Git
- A GitHub account

## Install the CLI

```bash
npm i -g @freeappstore/cli
```

## Create your app

```bash
fas login              # GitHub device-flow auth
fas init my-cool-app   # scaffold from template
cd my-cool-app
pnpm install && pnpm dev
```

Your app runs at `http://localhost:5173`. Edit `web/src/App.tsx` to build your app.

## Build your app on the Shell

Every FreeAppStore app has the same outer frame: `Shell` from `@freeappstore/sdk/ui`.
It renders the topbar (app name, avatar link to the profile page, theme and
text size) and your app's navigation, and wraps your screens in an error boundary,
loading fallback, toast region and offline banner. You write the screens.

1. **Wrap the app in `Shell`, with one `nav` entry per primary screen.** Detail
   routes do not each need a nav item. The Shell renders primary items
   as `<nav aria-label="Main">`, highlights the current screen, and collapses to a menu
   on phones.
2. **Start each primary screen with `PageHeader`**, its single `<h1>`.
3. **Give feedback with `useToast()`**, and build repeated controls from the
   [SDK components](ui.md).
4. **`Shell` is the supported default, not the only legal frame.** A custom frame,
   sidebar, or bottom nav must keep the
   [composable starter contract](composable-starter-contract.md): accessibility,
   platform identity, security, and the React styling rule. Do not add a second
   account menu. The avatar opens the profile page.

```tsx
import { useEffect, useState } from 'react';
import { initApp } from '@freeappstore/sdk';
import { type NavItem, PageHeader, Shell, useToast } from '@freeappstore/sdk/ui';

const fas = initApp({ appId: 'my-cool-app' });

const NAV: NavItem[] = [
  { label: 'Home', href: '/', title: 'My Cool App' },
  { label: 'Settings', href: '/settings', title: 'Settings — My Cool App' },
];

export default function App() {
  const [path, setPath] = useState(location.pathname);
  useEffect(() => {
    const sync = () => setPath(location.pathname);
    addEventListener('popstate', sync);
    return () => removeEventListener('popstate', sync);
  }, []);
  const navigate = (href: string) => {
    history.pushState(null, '', href);
    setPath(window.location.pathname);
  };

  return (
    <Shell app={fas} appName="My Cool App" nav={NAV} onNavigate={navigate}>
      {path === '/settings' ? <Settings /> : <Home />}
    </Shell>
  );
}

function Home() {
  return <PageHeader title="Home" description="Your app starts here." />;
}

function Settings() {
  const toast = useToast();
  return (
    <PageHeader
      title="Settings"
      actions={<button onClick={() => toast.show('Saved', { variant: 'success' })}>Save</button>}
    />
  );
}
```

The templates and VibeCode start you inside `Shell`. FreeAppStore is free, so there is
no subscription or upgrade screen. In the connected starter, only the private draft
feature asks users to sign in; public screens and Profile remain reachable. Use
`requireAuth` only when the whole app needs an account. Full reference and migration
guidance: [the Shell](ui.md#shell-the-standard-app-frame).

## Templates

```bash
fas init my-app                          # default: standalone (device-local, no sign-in gate)
fas init my-app --template connected     # uses platform backend (KV, rooms, etc.)
fas init asteroids --template game-canvas  # HTML5 canvas game
fas init chess --template game-grid        # grid-based game
fas init racing --template game-3d         # 3D game
```

| Template | Use case |
|----------|----------|
| `standalone` | Device-local by default, with no sign-in gate. Add IndexedDB or optional account capabilities as needed. Starts inside `Shell` with Home and About screens. |
| `connected` | Apps using platform account services through the SDK (auth, KV, collections, rooms, proxy). The generated private draft uses the race-safe hook from #350 and gates only its own data. Public screens and Profile stay reachable while signed out. |

Both names are presets generated from one canonical platform foundation. The
external template repositories are release mirrors updated from that source;
`fas init` generates apps directly. See the [composable starter contract](composable-starter-contract.md)
and [CLI reference](cli.md#fas-init-app-id). Both route screens by
`location.pathname` with `onNavigate`, so adding a primary screen is one `nav`
entry plus one branch in `App`. A detail route does not need a nav item. Fresh Shell
starters use SDK `^0.16.32`; adding optional PWA to an existing app retains its
separate `>=0.16.15` API minimum.

Game templates are available for scaffolding, but publish games with the separate `fgs` CLI:

| Template | Use case |
|----------|----------|
| `game-canvas` | HTML5 Canvas games. |
| `game-grid` | Grid/tile-based games. |
| `game-3d` | Three.js 3D games. |

## Run compliance checks

```bash
fas check
```

Checks: no tracking SDKs, no payments, no ads, brand fonts present, PWA manifest valid, initial-load JS under 300KB gzipped, no leftover `APPNAME` placeholders.

## Publish

```bash
fas publish
```

This provisions a GitHub repo, R2 hosting route, storefront entry, and injects a deploy workflow. Then:

```bash
git remote add upstream https://github.com/freeappstore-online/my-cool-app.git
git push upstream main
```

Your app is live at `https://my-cool-app.freeappstore.online` and listed on the storefront after the generated deploy workflow succeeds. Follow the exact remote and push commands printed by `fas publish`.

## Using the SDK

Install the SDK to use platform features (auth, storage, realtime):

```bash
npm i @freeappstore/sdk
```

```ts
import { initApp } from '@freeappstore/sdk';

const fas = initApp({ appId: 'my-cool-app' });
await fas.auth.init();

// Now you can use fas.auth, fas.kv, fas.rooms, fas.push, etc.
```

See the full [SDK Reference](sdk.md).

## Using VibeCode (AI builder)

Don't want to code? Go to [freeappstore.online/app/build](https://freeappstore.online/app/build), describe your app in plain English, and the AI builds and deploys it for you. VibeCode apps start inside the same `Shell`, with working navigation from the first render.

## Next steps

- [The Shell](ui.md#shell-the-standard-app-frame) -- props, migration from older layouts, caveats
- [SDK Reference](sdk.md) -- all modules and methods
- [UI Components](ui.md) -- drop-in React components
- [CLI Reference](cli.md) -- every `fas` command
- [Proxy & Keys](proxy-and-keys.md) -- call third-party APIs safely
