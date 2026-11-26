# FreeAppStore desktop

The FreeAppStore desktop app (Electron). Phase 1 (#797): it runs FAS apps in their own windows and lets an AI
client on this computer (Claude Code, Claude Desktop) use the tools those apps offer, on data that never leaves
the device.

```
Claude Code ──HTTP MCP──▶ desktop app (127.0.0.1:47821/mcp) ──IPC──────────▶ app window
                                                           └─ws /bridge──▶ app in a browser tab
```

A self-contained pnpm project outside the root workspace, like `workers/*`.

## Run

```bash
pnpm --dir desktop install
pnpm --dir desktop dev        # builds main, preloads and UI, then starts Electron
```

The home screen shows the MCP setup command, the connected apps and their tools; **Store** opens apps from
`registry.json` in desktop windows; **Activity** logs every AI call.

Development environment variables (dev builds, i.e. not packaged):

| Variable                                   | Effect                                                                                      |
| ------------------------------------------ | ------------------------------------------------------------------------------------------- |
| `FAS_DEV_APP_ORIGIN=http://localhost:5173` | Load every app window from a local dev server instead of `https://<id>.freeappstore.online` |
| `FAS_DESKTOP_PORT`                         | Listen on another port (default `47821`)                                                    |
| `FAS_DESKTOP_USER_DATA`                    | Use another profile directory (token, app data)                                             |

Dev builds also accept bridge connections from `http://localhost:*` and `http://127.0.0.1:*` pages.

## Connect Claude Code

Copy the command from the home screen and run it once:

```bash
claude mcp add --transport http fas http://127.0.0.1:47821/mcp --header "Authorization: Bearer <token>"
```

Then ask, for example, "list my open FreeAppStore apps". Tools: `list_open_apps`, `app_tools(app_id)`,
`app_call(app_id, tool, args)`, `open_app(app_id)`. **Regenerate token** on the home screen revokes the old one.

How an app offers tools (`exposeTools` from `@freeappstore/sdk/bridge`): [docs/mcp.md](../docs/mcp.md#local-ai-access-to-app-data-freeappstore-desktop).

## Security

- The server binds to `127.0.0.1` only.
- `/mcp` requires the per-install bearer token (compared in constant time), kept in the app's userData as
  `mcp-token` with mode `0600` and never logged. Any request carrying an `Origin` header is refused, so web pages
  can't drive it.
- `/bridge` accepts only `Origin: https://<id>.freeappstore.online` (plus localhost in dev builds), and such a
  page may only register app `<id>`.
- App windows: `contextIsolation`, `sandbox`, no `nodeIntegration`, a preload that exposes only
  `fasDesktopBridge`. Navigation stays on the app's origin; other links open in the system browser. The app id a
  window registers comes from the window, not the page.
- Messages are capped at 1 MB; calls time out after 30 s.

## Test

```bash
pnpm --dir desktop lint && pnpm --dir desktop typecheck && pnpm --dir desktop test
pnpm --dir desktop test:e2e   # Playwright + Electron: real MCP client, desktop window and browser tab paths
```

The end-to-end test serves a toy app that runs the SDK's `packages/sdk/src/bridge.ts`. Set `FAS_SHOTS_DIR` to
keep its screenshots.

## Build

```bash
pnpm --dir desktop dist:mac   # unsigned: release/FreeAppStore-<version>-mac.zip
```

The build is not signed or notarized, so macOS Gatekeeper blocks it on other machines (right-click → Open).
Signing, notarization, auto-update and the download page are #799.

## Layout

| Path                               | What                                                                                |
| ---------------------------------- | ----------------------------------------------------------------------------------- |
| `src/main/index.ts`                | Electron: windows, navigation guards, IPC                                           |
| `src/main/server.ts`               | Loopback HTTP server: `/mcp` (Streamable HTTP, stateless) and `/bridge` (WebSocket) |
| `src/main/mcp.ts`                  | The four MCP tools                                                                  |
| `src/main/hub.ts`                  | Connected apps, call routing, timeouts, activity log                                |
| `src/main/security.ts`, `token.ts` | Origin rules, token check and storage                                               |
| `src/preload/`                     | `app.cts` (app windows: bridge only), `home.cts` (home UI)                          |
| `src/renderer/`                    | Home UI (React + Tailwind 4 on the FAS tokens)                                      |
