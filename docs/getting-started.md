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

Don't want to code? Go to [create.freeappstore.online](https://create.freeappstore.online), describe your app in plain English, and the AI builds and deploys it for you.

## Next steps

- [SDK Reference](sdk.md) -- all modules and methods
- [UI Components](ui.md) -- drop-in React components
- [CLI Reference](cli.md) -- every `fas` command
- [Proxy & Keys](proxy-and-keys.md) -- call third-party APIs safely
