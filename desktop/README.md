# FreeAppStore desktop

The FreeAppStore desktop app (Electron). Phase 1 (#797): it runs FAS apps in their own windows and lets an AI
client on this computer (Claude Code, Claude Desktop) use the tools those apps offer, on data that never leaves
the device.

```
Claude Code / Desktop ──stdio──▶ FreeAppStore binary, node mode (dist/stdio/main.mjs)
                                   └─HTTP MCP──▶ desktop app (127.0.0.1:47821/mcp) ──IPC──────────▶ app window
                                                                                  └─ws /bridge──▶ app in a browser tab
```

It runs in the background like a service (#815): a menu-bar (tray) icon, open at login, and closing the window
keeps it running. Quit from the tray menu or with Cmd+Q.

A self-contained pnpm project outside the root workspace, like `workers/*`.

**Install:** download the preview installer for Mac, Windows or Linux from
[freeappstore.online/download](https://freeappstore.online/download), which also has the first-launch steps for
these unsigned builds.

## Run

```bash
pnpm --dir desktop install
pnpm --dir desktop dev        # builds main, preloads and UI, then starts Electron
```

The home screen leads with the status (**Pause AI access** / **Resume**, **Open at login**) and the **Connect**
buttons for Claude Code and Claude Desktop, then the connected apps and their tools, and a collapsed **Manual
setup** with the HTTP command and token for other AI apps. **Store** opens apps from `registry.json` in desktop
windows; **Activity** logs every AI call. The tray menu shows the status and offers Open, Pause / Resume and Quit.

Development environment variables (dev builds, i.e. not packaged):

| Variable                                   | Effect                                                                                      |
| ------------------------------------------ | ------------------------------------------------------------------------------------------- |
| `FAS_DEV_APP_ORIGIN=http://localhost:5173` | Load every app window from a local dev server instead of `https://<id>.freeappstore.online` |
| `FAS_DESKTOP_PORT`                         | Listen on another port (default `47821`)                                                    |
| `FAS_DESKTOP_USER_DATA`                    | Use another profile directory (token, settings, app data); never registers a login item     |

Dev builds also accept bridge connections from `http://localhost:*` and `http://127.0.0.1:*` pages. Dev builds
never register a login item either.

Test overrides, so tests never touch real AI client configs (any build):

| Variable                            | Effect                                                                   |
| ----------------------------------- | ------------------------------------------------------------------------ |
| `FAS_DESKTOP_CLAUDE_DESKTOP_CONFIG` | Claude Desktop's config file                                             |
| `FAS_DESKTOP_CLAUDE_CLI`            | The `claude` CLI to run (skips the login-shell lookup)                   |
| `FAS_DESKTOP_CLAUDE_HOME`           | Where Claude Code profiles (`.claude.json`, `.claude-*/`) are looked for |

## Connect an AI app

Click **Connect** next to **Claude Code** or **Claude Desktop** on the home screen, then start a new Claude Code
session or quit and reopen Claude Desktop. Ask, for example, "list my open FreeAppStore apps". Tools:
`list_open_apps`, `app_tools(app_id)`, `app_call(app_id, tool, args)`, `open_app(app_id)`.

Connect installs a **stdio** entry named `freeappstore-desktop` (never `freeappstore`, the remote server at mcp.freeappstore.online): the app's own binary with `ELECTRON_RUN_AS_NODE=1`
running `dist/stdio/main.mjs` (unpacked from the asar archive: `Contents/Resources/app.asar.unpacked/…` on macOS).
That proxy forwards stdio to `/mcp`, reading the token from userData on every request, so client configs hold
no token and **Regenerate token** breaks nothing. If the app isn't running, the proxy starts it in the
background (`--hidden`; the single-instance lock keeps one GUI) and waits up to 20 s; otherwise tool calls get
"FreeAppStore isn't running. Open FreeAppStore and try again."

- **Claude Desktop:** adds or removes `mcpServers.freeappstore-desktop` in `claude_desktop_config.json` (macOS
  `~/Library/Application Support/Claude/`, Windows `%APPDATA%\Claude\`), keeping everything else in the file.
- **Claude Code:** runs `claude mcp add-json --scope user` / `claude mcp remove --scope user`. A GUI app doesn't
  inherit the shell's environment, so the `claude` path, `PATH` and `CLAUDE_CONFIG_DIR` come from the user's
  login shell (`$SHELL -ilc`), falling back to `~/.local/bin/claude`. It registers in every profile it finds:
  `~/.claude.json`, the shell's `CLAUDE_CONFIG_DIR`, and each `~/.claude-*/` holding a `.claude.json` (profiles
  picked with an alias such as `CLAUDE_CONFIG_DIR=~/.claude-work claude`). Without a CLI (and on Windows) it edits
  those `.claude.json` files directly.

Other AI apps: **Manual setup** on the home screen has the HTTP endpoint and its bearer token:

```bash
claude mcp add --transport http fas http://127.0.0.1:47821/mcp --header "Authorization: Bearer <token>"
```

**Pause AI access** (home screen or tray) is kept in userData `settings.json`, with **Open at login**. While
paused, every MCP tool returns an `isError` result ("FreeAppStore AI access is paused. …") and no app tool runs;
the server stays up, so clients stay connected.

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

The e2e test also clicks Connect / Disconnect against temp client configs and a fake `claude`
(`e2e/fixture/fake-claude.mjs`), runs the stdio entry Connect wrote with a real `StdioClientTransport`, pauses and
resumes, and closes the window while the server keeps answering.

The end-to-end test serves a toy app that runs the SDK's `packages/sdk/src/bridge.ts`. Set `FAS_SHOTS_DIR` to
keep its screenshots.

## Build

```bash
pnpm --dir desktop dist:mac   # unsigned, ad-hoc signed: release/FreeAppStore-mac-{x64,arm64}.{dmg,zip}
```

### Release

`.github/workflows/desktop-release.yml` builds the installers on GitHub Actions: macOS dmg + zip (x64 and arm64,
ad-hoc signed so Apple Silicon starts them), Windows NSIS `.exe` and Linux AppImage. Start it by pushing a tag, or
run the workflow by hand with a version (it creates the tag):

```bash
git tag desktop-v0.1.1 && git push origin desktop-v0.1.1
```

CI sets `package.json`'s version from the tag. Each run publishes the release `desktop-v<version>` and refreshes
`desktop-latest`, whose asset URLs never change; the download page links there:
`https://github.com/freeappstore-online/platform/releases/download/desktop-latest/FreeAppStore-mac-x64.dmg`
(also `-mac-arm64.dmg`, `-mac-{x64,arm64}.zip`, `-win-x64.exe`, `-linux-x86_64.AppImage`).

The builds are not signed with a certificate or notarized, so macOS Gatekeeper and Windows SmartScreen warn on
first launch. Signing, notarization and auto-update are #799.

## Layout

| Path                               | What                                                                                   |
| ---------------------------------- | -------------------------------------------------------------------------------------- |
| `src/main/index.ts`                | Electron: windows, tray, login item, navigation guards, IPC                            |
| `src/main/server.ts`               | Loopback HTTP server: `/mcp` (Streamable HTTP, stateless) and `/bridge` (WebSocket)    |
| `src/main/mcp.ts`                  | The four MCP tools                                                                     |
| `src/main/hub.ts`                  | Connected apps, call routing, timeouts, activity log                                   |
| `src/main/security.ts`, `token.ts` | Origin rules, token check and storage                                                  |
| `src/main/integrations.ts`         | Connect / Disconnect for Claude Code and Claude Desktop                                |
| `src/main/settings.ts`, `tray.ts`  | Pause and open-at-login settings; the tray menu                                        |
| `src/stdio/`                       | The stdio MCP entry (`main.mjs`) and its proxy                                         |
| `assets/`                          | Tray icons: `trayTemplate*.png` (macOS, from `brand/assets/mark-mono.svg`), `tray.png` |
| `src/preload/`                     | `app.cts` (app windows: bridge only), `home.cts` (home UI)                             |
| `src/renderer/`                    | Home UI (React + Tailwind 4 on the FAS tokens)                                         |
