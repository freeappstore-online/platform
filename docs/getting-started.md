# Getting Started

Scaffold, build, and publish a free app in under a minute.

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
It renders the topbar (FreeAppStore link, app name, sign-in and profile menu, theme and
text size) and your app's navigation, and wraps your screens in an error boundary,
loading fallback, toast region and offline banner. You write the screens.

1. **Wrap the app in `Shell`, with one `nav` entry per screen.** The Shell renders them
   as `<nav aria-label="Main">`, highlights the current screen, and collapses to a menu
   on phones.
2. **Start each screen with `PageHeader`**, its single `<h1>`.
3. **Give feedback with `useToast()`**, and build screens from the
   [SDK components](ui.md) instead of hand-rolled chrome.
4. **Don't add** your own header, sidebar, tab bar, bottom dock or error boundary, and
   don't put navigation inside a screen.

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
    setPath(href);
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
no subscription or upgrade screen; the only gate is the optional sign-in gate
(`requireAuth`), for apps where everything needs an account. Full reference, migration
from older layouts, and caveats: [the Shell](ui.md#shell-the-standard-app-frame).

## Templates

```bash
fas init my-app                          # default: standalone (localStorage only)
fas init my-app --template connected     # uses platform backend (KV, rooms, etc.)
fas init asteroids --template game-canvas  # HTML5 canvas game
fas init chess --template game-grid        # grid-based game
fas init racing --template game-3d         # 3D game
```

| Template | Use case |
|----------|----------|
| `standalone` | Apps that only need localStorage. No backend dependency. |
| `connected` | Apps that use the SDK (auth, KV, rooms, counters, etc.). |
| `game-canvas` | HTML5 Canvas games. |
| `game-grid` | Grid/tile-based games. |
| `game-3d` | Three.js 3D games. |

## Run compliance checks

```bash
fas check
```

Checks: no tracking SDKs, brand fonts present, PWA manifest valid, bundle under 300KB gzipped, no leftover `APPNAME` placeholders.

## Publish

```bash
fas publish
```

This provisions a GitHub repo, R2 hosting route, storefront entry, and injects a deploy workflow. Then:

```bash
git push upstream main
```

Your app is live at `https://my-cool-app.freeappstore.online` and listed on the storefront within ~30 seconds.

## Using the SDK

Install the SDK to use platform features (auth, storage, realtime):

```bash
npm i @freeappstore/sdk
```

```ts
import { initApp } from '@freeappstore/sdk';

const fas = initApp({ appId: 'my-cool-app' });
await fas.auth.init();

// Now you can use fas.auth, fas.kv, fas.rooms, etc.
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
