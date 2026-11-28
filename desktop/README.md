# FreeAppStore desktop

The FreeAppStore desktop app (Electron). Phase 1 (#797): it runs FAS apps in their own windows and lets an AI
client on this computer (Claude Code, Claude Desktop) use the tools those apps offer. Calls stay on this computer and
never reach a FreeAppStore server; what a tool returns goes to that AI client, which may send it to its model
provider ([where data goes](../docs/device-data.md)). User guide: [docs/devices.md](../docs/devices.md).

```
Claude Code / Desktop ──stdio──▶ FreeAppStore binary, node mode (dist/stdio/main.mjs)
                                   └─HTTP MCP──▶ desktop app (127.0.0.1:47821/mcp) ──IPC──────────▶ app window
                                                                                  └─ws /bridge──▶ app in a browser tab
```

It runs in the background like a service (#815): a menu-bar (tray) icon, open at login, and closing the window
keeps it running. Quit from the tray menu or with Cmd+Q.

A self-contained pnpm project outside the root workspace, like `workers/*`.

**Install:** use [freeappstore.online/download](https://freeappstore.online/download), which lists verified release
installers and their installation steps. Mac downloads require Developer ID signing and notarization; Windows
Store distribution is being prepared. Local development packages are not public release installers.

## Run

```bash
pnpm --dir desktop install
pnpm --dir desktop dev        # builds main, preloads and UI, then starts Electron
```

The home screen leads with the status (**Pause AI access** / **Resume**, **Open at login**) and the **Connect**
buttons for Claude Code and Claude Desktop, then the connected apps and their tools, and a collapsed **Manual
setup** with the HTTP command and token for other AI apps. **Store** opens apps from `registry.json` in desktop
windows, sorted Newest (default), Most popular, A–Z or by Category, with the choice remembered (#834), with category
chips, a **Recent** row of apps opened on this computer and starred favourites pinned first (#840; both in userData
`settings.json`, never on the server). **Vote** opens the app on freeappstore.online, since voting needs a storefront
sign-in and the device credential isn't one; **Contribute** generates community jobs ([below](#contribute)); **Activity** logs every AI call. The tray
menu shows the status and offers Open, Pause / Resume and Quit, plus Contribute's status and its mode (Auto,
Run now, Off) while this computer is connected.

**Account** (#829): once this computer is connected (Contribute's **Connect this computer**, also offered by the
header's **Sign in**), the header shows the account's avatar and name and the tray menu its name and avatar. The
Account page shows the avatar, name, `@login` (or the sign-in provider), user id, email, platform roles, the number
of apps for creators with a console link, and this computer's label, connection date and expiry, all from
`GET /v1/native/me` with the device credential (the profile is held in memory only; the avatar is fetched by the main
process and handed over as a `data:` URL, since the page's CSP allows no remote images). **Sign out** revokes the device
credential, like Contribute's **Disconnect**; **Delete account** opens the console's deletion flow. The page also
shows this build's version, and **Add a phone** (#845) shows a 5-minute, single-use code from
`POST /v1/native/pair-codes` (made with the device credential) as a QR code (`uqr`, drawn locally) and as text, for the
phone app to scan ([docs/native-companion.md](../docs/native-companion.md#qr-pairing-845)); the console's Settings >
Devices lists every device with its version and Revoke. Pairing and every call with the device credential send
`X-FAS-App-Version` (the version label) and `X-FAS-Client: desktop` (#833).

Development environment variables (dev builds, i.e. not packaged):

| Variable                                   | Effect                                                                                      |
| ------------------------------------------ | ------------------------------------------------------------------------------------------- |
| `FAS_DEV_APP_ORIGIN=http://localhost:5173` | Load every app window from a local dev server instead of `https://<id>.freeappstore.online` |
| `FAS_DESKTOP_PORT`                         | Listen on another port (default `47821`)                                                    |
| `FAS_DESKTOP_USER_DATA`                    | Use another profile directory (token, settings, app data); never registers a login item     |
| `FAS_DEV_API_ORIGIN=http://127.0.0.1:8787` | Contribute talks to this API instead of `https://api.freeappstore.online`                   |
| `FAS_DEV_MODEL_URL`                        | Contribute downloads the model package from here (it must still match the pinned SHA-256)   |

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

## Publish

**Publish** (#800) creates, checks, publishes and pushes apps from this computer. It is a GUI over the `fas` CLI
(`@freeappstore/cli`, a pinned dependency), so init, compliance, the deploy workflow and `/v1/publish` are the CLI's own
code. The page runs the bundled CLI the way Connect runs the stdio proxy: this app's binary in node mode
(`ELECTRON_RUN_AS_NODE=1`) on `dist/cli/fas.mjs` (`src/cli/fas.mts`), with an argument list and no shell.

- **Sign in with GitHub** runs `fas login`: the page shows GitHub's device code and opens `github.com/login/device`;
  the CLI exchanges the GitHub token at `/v1/auth/exchange` for a 30-day console session and keeps it in
  `~/.fas/config.json` (mode `0600`). It is **the CLI's sign-in**: signing in or out here does the same for `fas`
  in a terminal, and the reverse. **Sign out** runs `fas logout`, which deletes that file.
- **Your published apps** come from `GET /v1/apps/mine`, fetched by the wrapper (`fas.mjs --my-apps`) with the
  CLI's own config code: `fas list --json` would also call GitHub's API once per app. Each has **Open** (a desktop
  window), **Edit with VibeCode** (`freeappstore.online/app/build/app/<id>`) and **Console**.
- **On this computer**: **New app** runs `fas init <id>` in a folder you choose (the standalone starter, with a first
  commit); **Add folder** adds a folder with a `fas.json` app id. The list is userData `settings.json`
  `publishProjects`; **Remove** takes a folder off it and leaves the folder. Each project has **Check**
  (`fas check --json`), **Publish…** (a category and a one-line description, then
  `fas publish --yes --name <id> --category … --type standalone --oneliner …`), and once published **Push**
  (**Commit and push** with a message while files have changed: `git add -A`, `git commit`, then
  `git push <repo>.git main`). Push uses your own git credentials and goes only to
  `https://github.com/freeappstore-online/<id>` as `/v1/apps/mine` reports it. Push to main deploys.
- The output of the command running (or last run) shows on the page; **Stop** ends it. One command runs at a time.

Security: the main process and the page never read the console session; only the CLI does, as in a terminal. The
`ndev_` device credential (Contribute, Account) is not used for publishing and can't be exchanged for a console
session: it is a long-lived credential for the native routes, and `/v1/publish` also needs a GitHub identity. The
page names projects; the main process accepts only folders the user picked in a folder dialog. Packaged builds remove
`FAS_API_BASE` from the CLI's environment, so they always publish through `api.freeappstore.online`.

Dev builds only: `FAS_DEV_API_ORIGIN` also reaches the CLI (as `FAS_API_BASE`), `FAS_DESKTOP_CLI_HOME` is the home
directory of the CLI and git (so tests never touch `~/.fas`), and Push takes any repository URL the API reports.

## Contribute

Contribute (#826) lends this computer to community generation ([docs/community-generation.md](../docs/community-generation.md)):
it generates narration jobs for the store apps you opt in to, with the phones' engine (#837: Kokoro v1.0 through
sherpa-onnx, CPU, the same model package, voices and language rule as android `Kokoro.kt`, so English, Spanish and
Mandarin), and keeps going while the window is closed, as long as FreeAppStore runs in the tray.

- **Connect**: the desktop app has no FreeAppStore sign-in of its own, so **Connect this computer** uses the phones'
  device pairing ([docs/native-companion.md](../docs/native-companion.md)): the browser opens the pairing page, you sign
  in and approve (the page still talks about a phone), and the app redeems the approval for an `ndev_` device
  credential, kept in userData as `device-token` (mode `0600`, never logged; 90 days). **Disconnect** revokes it on the
  server and deletes it. A credential the server refuses (expired, revoked) is dropped and the page asks to connect
  again. Submissions from the desktop are `device_kind` `native`.
- **One account's** (#848): the history, kept audio and opt-ins belong to the account recorded with them
  (`contributeAccount` in `settings.json`). **Disconnect** / **Sign out** deletes `contribute-history.json`,
  `contribute-audio/` and the opt-ins, as the phones' Disconnect does. A credential the server refused keeps them, hidden;
  after the next connect, `/native/me` says whose account it is: the same account gets them back, another one has them
  deleted first. Until that check nothing is shown and nothing is claimed. A job, upload or verdict refresh still running
  at sign-out writes nothing afterwards. The downloaded model stays (it is not an opt-in) until **Delete model**.
- **Opt in** per app from discovery (`GET /v1/generation/open`; apps whose sets this engine can't do are listed
  with why: `kokoroProblem` in `src/main/kokoro.ts`), and **Download the model** after seeing its size: the phones'
  `kokoro-multi-lang-v1_0.tar.bz2` (350 MB) from sherpa-onnx's GitHub release, checked against its pinned SHA-256
  before anything is unpacked (regular files and directories only, inside the folder), unpacked to
  `userData/kokoro` (about 400 MB) until **Delete model** (`src/main/model.ts`). Download and unpacking (about two
  minutes of bzip2) run in the TTS process. Nothing is claimed before both.
- **Loop**, in the main process: discovery, then one job from each opted-in app in turn until none has work, then a
  new look every 15 minutes (or at once after a setting changes). Claim retries, the upload resend and lease
  extension are the SDK's (`Generation.contribute`): the same behaviour as the phones (#819) and the browser. The
  main process makes every API call with the device credential (plain `fetch`, no CORS, no page sees the
  credential). Pause (home or tray) stops the job in hand at once; its lease runs out on the server.
- **Engine**: synthesis runs in an Electron utility process (`src/main/tts.ts`) with `sherpa-onnx-node` (its prebuilt
  addon for mac arm64/x64, Windows x64 and Linux x64, unpacked from the archive by electron-builder), up to 4 threads,
  Mandarin with its own engine and the package's number and date rules. `NativeRunner` (`src/main/kokoro.ts`) speaks
  a job a sentence at a time (the phones' splitting for English, Spanish and Mandarin, Books' 0.4 s / 0.8 s pauses,
  audio under a second padded), and stands in for the SDK's `KokoroRunner` in `contributeKokoroApps`. The main
  process has no WebCodecs, so AAC encoding runs in a hidden window (`src/renderer/contribute.*`,
  `backgroundThrottling: false`, sandboxed, a preload that only relays encoder messages): samples go over a sentence
  at a time, the MP4 comes back as bytes (`src/main/engine.ts`). The TTS process ends after each run, freeing the
  model's memory. The page encodes with WebCodecs' AAC encoder and muxes with Mediabunny. Electron 45 on macOS refuses
  24 kHz AAC, so the audio is 32 kbps mono at 48 kHz there. Chromium has no AAC encoder on Linux (#854): there the
  page registers `@mediabunny/aac-encoder` (FFmpeg's AAC-LC encoder built to WebAssembly, LGPL-2.1, in a worker; about
  1 MB, bundled, offline), which encodes 32 kbps mono at 24 kHz.
- **When it runs** (#830, `src/main/conditions.ts`), all decided on this computer, as on the phones. Modes: **Auto**
  (the default) runs whenever every condition holds and pauses the moment one fails; **Run now** is one run that
  ignores the conditions, then Auto; **Off** is the hard stop: it stops the job in hand, nothing starts again until it
  is turned on, and it is kept in `settings.json` across restarts and updates ("Contribute is off. It will not start
  again until you turn it on."; a Pause from before #830 is Off). Conditions, defaults in brackets: power, AC only or
  also on battery from a minimum [AC only, 40%] (`powerMonitor.isOnBatteryPower`, the level from the hidden window's
  `navigator.getBattery`; a computer without a battery is on AC); pause when hot [on] (macOS thermal state serious or
  critical, or an advertised CPU speed limit under 100%); while the computer is in use, pause or run slower [pause]
  (in use: `getSystemIdleState(120)` is active, so a key or the mouse in the last 2 minutes, screen unlocked); CPU
  Light / Balanced / Full [Balanced] (sherpa-onnx threads 1 / 2 / up to 4, rests after each sentence of 100% / 25% /
  none of its time; run slower rests at least 100%); daily maximum of jobs and minutes [none]; quiet hours [off]. A
  metered connection can't be told on a computer, so there is no data condition. They are checked before each claim
  and between sentences: a job at least 80% done finishes, any other stops and its attempt record says why
  (`unplugged`, `thermal`, otherwise `user_stop`), so the server gives it back (#841). Held, it checks again every
  minute and on power and heat changes, without asking the server for work.
- The **Contribute** page shows the status (running with app, job and sentence n of N, waiting and why, paused and
  the condition that holds it, or off), the mode, **When it runs**, the
  counts since the app started, the engine, its languages and the model, and the apps with their switches, and the
  **History** (#827): the job in hand as **In progress** from its claim (#838; its detail follows it live: engine,
  sentence n of N, elapsed and CPU time, computer, lease expiry, then the audio once encoded; a run cut off by a quit
  or crash is closed at the next start as stopped, interrupted), and every job this computer tried (`userData/contribute-history.json`, 200 newest) with the server's verdict and the attempt's numbers
  (how it ended, foreground or background, wall time per stage, CPU time and memory of all FreeAppStore processes from
  `app.getAppMetrics()`, plugged in or on battery and the macOS thermal state from `powerMonitor`), and playback with
  sentence highlighting of the 20 latest attempts' audio (`userData/contribute-audio`). The numbers, not the text or
  audio, go to `…/generation/events` (`src/main/history.ts`). **Save record…** in an item's detail (#843) writes a
  folder you name with `record.json` (the item with its numbers, verdict and sentence timings) and `audio.m4a`.

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
- App permissions: camera, microphone, location and notifications require approval for that window. Cross-origin
  frames and unsupported permissions (including clipboard reads, device access and screen capture) are denied.
- Messages are capped at 1 MB; calls time out after 30 s. Malformed request URLs return 400.
- AI activity survives updates and restarts in `userData/ai-activity.json` (0600, atomic replacement, latest 1,000).
  Only timestamps, tool/app names and success are saved; arguments, results and error bodies are excluded. The
  Activity screen can clear this computer's record. A corrupt file is preserved and shown as an error.
- Native pairing/profile requests reject redirects and time out after 20 seconds.
- Public signing gates, verified findings and remaining distribution requirements: [native security audit](../docs/native-security-audit.md).
- Signing credentials, Microsoft Store packaging and exact installer verification: [trusted desktop distribution](SIGNING.md).

## Test

```bash
pnpm --dir desktop lint && pnpm --dir desktop typecheck && pnpm --dir desktop test
pnpm --dir desktop test:e2e   # Playwright + Electron: real MCP client, desktop window and browser tab paths
```

CI (`.github/workflows/desktop.yml`, also run on every release tag before publishing) runs all of these on Linux
under xvfb, except the tests marked "needs the network" and the real-model Contribute test.

The e2e test also clicks Connect / Disconnect against temp client configs and a fake `claude`
(`e2e/fixture/fake-claude.mjs`), runs the stdio entry Connect wrote with a real `StdioClientTransport`, pauses and
resumes, and closes the window while the server keeps answering.

The end-to-end test serves a toy app that runs the SDK's `packages/sdk/src/bridge.ts`. Set `FAS_SHOTS_DIR` to
keep its screenshots.

`e2e/contribute.spec.ts` runs Contribute with the real model against a stand-in API: it downloads the model, closes
the window, generates an English (`books`) and a Mandarin (`dialogue`, `zh`) job, and checks each upload is mono AAC
in MP4 whose length matches its sentence timings and is not silent (`ffprobe`/`ffmpeg`); the files are left in
`test-results/uploads`. It downloads the model package, so it runs only with `FAS_E2E_MODEL=1`;
`FAS_E2E_MODEL_FILE` serves an already downloaded `kokoro-multi-lang-v1_0.tar.bz2` from the stand-in instead:

```bash
pnpm --dir desktop build && FAS_E2E_MODEL=1 pnpm --dir desktop exec playwright test e2e/contribute.spec.ts
```

`e2e/publish.spec.ts` runs New app, Check, Publish and Push with the real bundled CLI against a stand-in API (never
the real `/v1/publish`), the CLI's sign-in in a temporary home and a local bare repository as the app's repository.

`e2e/account.spec.ts` checks the header summary and the Account page against a stand-in `/native/me`, and that Sign
out revokes the credential (`DELETE /v1/native/device`).

## Build

```bash
pnpm --dir desktop dist:mac   # unsigned, ad-hoc signed: release/FreeAppStore-mac-{x64,arm64}.{dmg,zip}
```

### Release

The public download page accepts versioned releases only after their installer hashes, signing manifest and GitHub
provenance pass verification. It does not fall back to an unsigned `desktop-latest` package. See
[SIGNING.md](SIGNING.md) and [the native security audit](../docs/native-security-audit.md) for required evidence.

For the existing Xcode account, `scripts/cloud-sign-mac.sh` builds both Mac architectures from an immutable
`desktop-v<version>` tag, uses Apple's cloud-managed Developer ID signing and notarization, and verifies the
stapled apps before creating ZIPs. Upload those ZIPs to the matching draft GitHub release, then run:

```bash
gh workflow run desktop-cloud-release.yml --repo freeappstore-online/platform --ref main \
  -f version=1.0.0 -f build=2026112801
```

The workflow validates the draft assets against the tagged source, runs Desktop CI, independently verifies Mac
signatures and notarization, builds Linux, and publishes only after all gates pass. It also refreshes the Mac and
Linux `desktop-latest` update feeds. This example identifies the first signed release candidate; it is not an
instruction to overwrite an already-published version.

`.github/workflows/desktop-release.yml` provides the alternative exportable-certificate route. Its required
signing configuration must exist before it creates a tag. Windows direct installers are optional and require
Authenticode signing plus separately verified installation behavior. `.github/workflows/desktop-store.yml`
prepares the Windows Store submission package after Partner Center supplies the reserved package identity.

### Updates

Installed builds look for a newer version when they start and once a day (#839, `src/main/updates.ts`, electron-updater),
unless **Check for updates automatically** is off (Account > About, which also has **Check now**). The feed is
`desktop-latest` (electron-builder.yml `publish`): the release workflow uploads `latest.yml`, `latest-linux.yml` and
`latest-mac.yml` there after the installers. Windows and Linux (AppImage) download the update in the background and offer
**Restart to update** (otherwise it installs on quit). Microsoft Store builds use Store-managed updates. The Mac app
uses manual replacement: it says which version is available and **Download** opens that version's signed ZIP for
this Mac. A banner and the tray menu show an
available update. **What's new** shows the GitHub release notes of the new and the current version: the desktop's commits
since the previous desktop tag. Dev builds never check.

## Layout

| Path                               | What                                                                                    |
| ---------------------------------- | --------------------------------------------------------------------------------------- |
| `src/main/index.ts`                | Electron: windows, tray, login item, navigation guards, IPC                             |
| `src/main/server.ts`               | Loopback HTTP server: `/mcp` (Streamable HTTP, stateless) and `/bridge` (WebSocket)     |
| `src/main/mcp.ts`                  | The four MCP tools                                                                      |
| `src/main/hub.ts`                  | Connected apps, call routing, timeouts, activity log                                    |
| `src/main/security.ts`, `token.ts` | Origin rules, token check and storage                                                   |
| `src/main/integrations.ts`         | Connect / Disconnect for Claude Code and Claude Desktop                                 |
| `src/main/settings.ts`, `tray.ts`  | Pause, open-at-login, Contribute, update and Store settings; the tray menu              |
| `src/main/updates.ts`              | Update checks, download and install (electron-updater)                                  |
| `src/main/contribute.ts`           | Contribute's loop and state                                                             |
| `src/main/kokoro.ts`, `model.ts`   | The phones' Kokoro rules and `NativeRunner`; the model package's install                |
| `src/main/tts.ts`, `engine.ts`     | The TTS utility process (sherpa-onnx); its client and the hidden window's encoder relay |
| `src/main/device.ts`               | Device pairing (`ndev_` credential), its storage, the account from `/native/me`         |
| `src/main/publish.ts`              | Publish: runs the bundled `fas` CLI and git, reads their output                         |
| `src/cli/`                         | The bundled `fas` CLI's entry (`fas.mjs`), run in node mode                             |
| `src/stdio/`                       | The stdio MCP entry (`main.mjs`) and its proxy                                          |
| `assets/`                          | Tray icons: `trayTemplate*.png` (macOS, from `brand/assets/mark-mono.svg`), `tray.png`  |
| `src/preload/`                     | `app.cts` (app windows: bridge only), `home.cts` (home UI), `contribute.cts`            |
| `src/renderer/`                    | Home UI (React + Tailwind 4 on the FAS tokens); `contribute.*`: the hidden encoder page |
