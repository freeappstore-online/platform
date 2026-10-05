# FreeAppStore — Claude Code Guide

You are building a free app for [freeappstore.online](https://freeappstore.online). Read this entire file before writing any code.

## Setup (run these before anything else)

```bash
npm i -g @freeappstore/cli
fas init my-app
cd my-app
pnpm install
```

This gives you a runnable React + TypeScript + Vite + Tailwind project with the platform's brand, layout, and PWA manifest already configured.

### Authenticate for publishing

If `gh` CLI is logged in, authenticate `fas` non-interactively:

```bash
mkdir -p ~/.fas
GH_TOKEN=$(gh auth token)
SESSION=$(curl -s -X POST https://api.freeappstore.online/v1/auth/exchange \
  -H 'Content-Type: application/json' \
  -d "{\"githubToken\": \"$GH_TOKEN\"}" | python3 -c "import sys,json; print(json.load(sys.stdin)['sessionToken'])")
GH_LOGIN=$(gh api user --jq '.login')
cat > ~/.fas/config.json << EOF
{"apiBase":"https://api.freeappstore.online","github":{"accessToken":"$GH_TOKEN","login":"$GH_LOGIN","obtainedAt":$(date +%s)000},"session":{"token":"$SESSION","obtainedAt":$(date +%s)000}}
EOF
chmod 600 ~/.fas/config.json
```

If `gh` is not available, run `fas login` (opens browser for GitHub device flow).

## MCP (build from your editor)

You can build, publish, and improve apps **without leaving your editor** via the FreeAppStore MCP server. Connect it once:

```bash
# Claude Code
claude mcp add freeappstore -- npx mcp-remote https://mcp.freeappstore.online/mcp
```

In Cursor (and other MCP clients), add a server whose command is `npx mcp-remote https://mcp.freeappstore.online/mcp`.

There are **two modes**:

1. **Your editor's AI writes the code, the MCP ships it.** Claude (or Cursor) generates the app locally, then calls the MCP tools to provision and push it: `create_app`, `update_files`, `read_file`, `list_files`.
2. **You just prompt — the platform's VibeCode agent writes + deploys it.** Hand the build off entirely: `agent_build` kicks off a server-side VibeCode run (using an AI key from your vault), and `agent_status` polls progress. No local code needed.

Authenticated tools use your `fas login` session token. Pass it to the server via the mcp-remote `--header` flag:

```bash
# Grab the session token from ~/.fas/config.json (.session.token), then:
claude mcp add freeappstore -- npx mcp-remote https://mcp.freeappstore.online/mcp \
  --header "Authorization: Bearer <token>"
```

Full guide: https://freeappstore.online/docs/mcp

## Tech stack (mandatory, no substitutions)

- TypeScript ^5.7, React ^19, Vite ^6, Tailwind CSS ^4.1, pnpm
- Node >=22
- All styling via CSS variables defined in `web/src/index.css`
- Layout via the SDK's `Shell` (`import { Shell } from '@freeappstore/sdk/ui'`, SDK 0.14.30+), already the root of `web/src/App.tsx`
- Build your app inside `<Shell app={fas} appName="…" nav={NAV} onNavigate={navigate}>` with one `NAV` entry per screen — it renders the topbar, the app's navigation (`<nav aria-label="Main">`), an error boundary, toasts and an offline banner. Start each screen with `<PageHeader title="…" />`; use `useToast()` for feedback. Never build your own header, sidebar, tab bar or bottom dock. Guide: https://docs.freeappstore.online/getting-started/#build-your-app-on-the-shell

## Brand rules (mandatory)

- Fonts: **Manrope** (body) + **Fraunces** (display/headings only)
- CSS variables: `--paper`, `--ink`, `--muted`, `--line`, `--panel`, `--accent`, `--success`, `--warning`, `--danger`
- Dark mode via `:root[data-theme='dark']` (already set up — the SDK sets it from the system or the Shell's theme toggle; just use the variables)
- Border radius: `1.25rem` cards, `0.75rem` buttons
- Never add custom display fonts. Never redefine CSS variables.

## Privacy rules (mandatory)

- ZERO analytics, tracking, cookies, or third-party scripts (except Google Fonts in the template)
- All user data in `localStorage` (standalone) or `@freeappstore/sdk` KV (connected)
- No accounts required for standalone apps
- MIT license required

## File structure

```
my-app/
├── package.json           (root workspace — do not add deps here)
├── pnpm-workspace.yaml
├── LICENSE                (MIT — already included)
└── web/
    ├── package.json       (add deps here)
    ├── index.html
    ├── vite.config.ts
    ├── public/manifest.json
    └── src/
        ├── main.tsx       (do not modify)
        ├── index.css      (brand tokens — modify only to add app-specific vars)
        ├── App.tsx         (your app entry point: <Shell> with a NAV entry per screen)
        └── components/     (your screens)
```

## How to build

1. Edit `web/src/App.tsx` and add components in `web/src/components/`
2. Use the Shell component as root layout
3. Store data in `localStorage` with a namespaced key (e.g. `myapp_data`)
4. Keep bundle small — do not add npm dependencies unless absolutely necessary
5. Make it responsive (mobile-first) and handle empty states

## SDK — for apps that need accounts, cloud storage, or realtime

If the app needs user sign-in, per-user cloud storage, realtime collaboration, or third-party API calls, install the SDK:

```bash
cd web && pnpm add @freeappstore/sdk
```

```typescript
import { initApp } from '@freeappstore/sdk';

const fas = initApp({ appId: 'my-app' });

// Call once at app start — captures OAuth redirect
await fas.auth.init();

// Auth
fas.auth.signIn();                    // redirects to GitHub OAuth
fas.auth.signOut();                   // clears local session
fas.auth.user;                        // { id, login, avatarUrl } | null
fas.auth.onChange((user) => { ... }); // subscribe to auth changes

// Per-user KV (scoped to appId + userId, server-enforced)
await fas.kv.set('theme', { dark: true });
const theme = await fas.kv.get<{ dark: boolean }>('theme');
await fas.kv.delete('theme');
// Limits: 1MB/user, 100 keys/user, 64KB/value

// Realtime rooms (WebSocket, ephemeral)
const room = fas.rooms.join('lobby');
room.send({ text: 'hello' });
room.onMessage<{ text: string }>((msg) => console.log(msg.from.login, msg.data.text));
room.onPeers((peers) => console.log(peers));
room.close();
// Limits: 32 peers/room, 4KB/message, 100 msgs/sec/peer

// Secret-injecting proxy (keys never touch the browser)
const res = await fas.proxy.fetch('api.openweathermap.org/data/2.5/weather?q=London');
```

The SDK talks to `api.freeappstore.online`. No backend setup needed — it's platform-managed.

## Compliance checks

Before publishing, run:

```bash
fas check
```

This verifies: MIT license, no tracking SDKs, brand fonts (Manrope + Fraunces), CSS variables, HTML meta tags (lang, viewport, title), PWA manifest, mobile-web-app-capable, store link in source, dark mode support, pnpm workspace, no unreplaced template placeholders, bundle under 300KB gzipped.

## Publishing

```bash
pnpm build
fas check
fas publish --yes --name my-app --category Utilities --type standalone --oneliner "One-line description"
```

This atomically: creates `github.com/freeappstore-online/my-app`, sets up the hosting route for `my-app.freeappstore.online`, and adds the app to the store registry.

After publish, push your code to the new repo:

```bash
git remote add upstream https://github.com/freeappstore-online/my-app.git
git push upstream main
```

Every subsequent `git push upstream main` auto-deploys in ~30 seconds.

## What NOT to do

- Do NOT add analytics, tracking, or third-party scripts
- Do NOT use custom display fonts (Manrope + Fraunces only)
- Do NOT create a backend or API (use `@freeappstore/sdk` or `localStorage`)
- Do NOT use `wrangler` commands (deploy is `git push`)
- Do NOT ask the user for Cloudflare or GitHub tokens
- Do NOT add npm dependencies unless strictly necessary (React + Tailwind handle most things)
- Do NOT modify `web/src/main.tsx` unless absolutely necessary
- Do NOT commit `.env.production` files

## Source

- Platform repo: https://github.com/freeappstore-online/platform
- SDK docs: https://github.com/freeappstore-online/platform/tree/main/packages/sdk#readme
- CLI docs: https://github.com/freeappstore-online/platform/tree/main/packages/cli#readme
- Full platform guide: https://freeappstore.online/skills.md
