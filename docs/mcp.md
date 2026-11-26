# MCP Server

Connect an AI agent (Claude Code, Cursor, Codex, etc.) to FreeAppStore via MCP.

## Setup

### Claude Code

```bash
claude mcp add freeappstore -- npx mcp-remote https://mcp.freeappstore.online/mcp
```

### Codex

```bash
codex mcp add freeappstore --url https://mcp.freeappstore.online/mcp
```

### Cursor

Settings > MCP > Add Server: `npx mcp-remote https://mcp.freeappstore.online/mcp`

### Project-local `.mcp.json`

```json
{
  "mcpServers": {
    "freeappstore": {
      "command": "npx",
      "args": ["mcp-remote", "https://mcp.freeappstore.online/mcp"]
    }
  }
}
```

## Available Tools

### Build — write code yourself (your account)

| Tool | Description |
|------|-------------|
| `create_app` | Provision repo + hosting + listing, scaffold template, deploy live at `<id>.freeappstore.online` |
| `update_files` | Write/overwrite files in an app you own; auto-redeploys in ~30-60s |

### Build — let the VibeCode agent write code (your account + usable AI provider connection)

| Tool | Description |
|------|-------------|
| `agent_build` | Hand a prompt to the VibeCode agent; it writes the code and deploys it |
| `agent_status` | Poll an agent_build session for progress and live URL |
| `agent_activity` | Read your conversation with the build agent for a session you own: prompts, replies, tool actions |

### Read (any connected account)

| Tool | Description |
|------|-------------|
| `list_files` | List files in an app's repo |
| `read_file` | Read a specific file from an app's repo |

### Inspect

Every tool runs over the OAuth connection (see [Authentication](#authentication)). In the **Access** column, *Any* means the tool does not use your FAS session or account, *Your account* means it acts as you, and *Owner* means it also checks you own the app.

| Tool | Access | Description |
|------|------|-------------|
| `list_apps` | Your account | List your published apps |
| `app_info` | Any | Live URL, repo, store listing, up/down status |
| `deploy_status` | Any | Check last 5 GitHub Actions runs |
| `app_logs` | Owner | Recent errors, warnings, SDK calls, build info |
| `platform_guide` | Any | Fetch full SKILLS.md platform guide, followed by the current app-building rules |
| `sdk_reference` | Any | SDK reference. Start with `shell` (the standard app frame), then `components`; also auth, persistence and backup (where app data lives), counters, rooms, proxy, keys, push, hooks, ui. `kv` and `collections` are marked deprecated for app data ([ADR-004](https://github.com/freeappstore-online/platform/blob/main/docs/adr/004-no-server-app-data.md)) |
| `mcp_audit_log` | Your account | Your recent MCP audit events (writes, dry-runs, denials), newest first |

## Workflow Recipes

### Create and deploy a new app

```
"Create a todo app and deploy it."
Expected tool flow:
1. create_app       → provisions repo + hosting + listing, scaffolds template
2. list_files       → see the scaffolded template files
3. read_file        → read web/src/App.tsx
4. update_files     → wrap the app in <Shell app={fas} nav={NAV}> (one nav item per
                      screen), then write the screens (auto-deploys)
5. deploy_status    → confirm it went live
```

`create_app` and `platform_guide` end with the same build rules, and `sdk_reference`
feature `shell` has a complete example: the app is wrapped in `Shell` with real nav
items from the first render, screens start with `PageHeader` and use the SDK
components. See [Build your app on the Shell](getting-started.md#build-your-app-on-the-shell).

### Improve an existing app

```
"Add dark mode to my timer app."
Expected tool flow:
1. list_apps        → find the app
2. list_files       → see current file tree
3. read_file        → read the files you need to change
4. update_files     → push updated code
5. deploy_status    → confirm deploy
```

### Let the VibeCode agent build it

```
"Build me a pomodoro timer and deploy it as pomodoro."
Expected tool flow:
1. agent_build      → VibeCode agent writes + deploys (uses a supported provider connection or vaulted key)
2. agent_status     → poll until live URL is ready
```

### Debug a failing deploy

```
"My weather app deploy is failing."
Expected tool flow:
1. deploy_status    → check recent GitHub Actions runs
2. app_logs         → read errors and build info
3. read_file        → inspect the problematic file
4. update_files     → push a fix
```

## Capabilities

**Read** (any connected account):
- App metadata (info, listing, status)
- Deploy history (GitHub Actions runs)
- File tree and file contents (public repos)
- Platform guide (SKILLS.md)
- SDK reference docs

**Read** (your account):
- Your published app list
- App logs (errors, warnings, SDK calls)

**Write** (your account + app ownership):
- Create new apps (provision + scaffold + deploy)
- Update files in apps you own (auto-redeploys)

**Agent** (your account + usable AI provider connection):
- Trigger VibeCode agent builds
- Poll agent build status
- Read your agent build conversation

**Not supported via MCP:**
- Deleting apps or repos
- DNS or domain configuration
- Billing or subscription changes
- User account management
- Platform compliance rule changes
- Direct database (D1/KV) access
- Read or write users' app data. FAS stores no application data on the server ([ADR-004](https://github.com/freeappstore-online/platform/blob/main/docs/adr/004-no-server-app-data.md)); local AI access to an open app's on-device data is the desktop bridge (#797)

## Authentication

The MCP server authenticates with **OAuth 2.1** (automatic via `mcp-remote`). The OAuth flow redirects to FreeAppStore sign-in, then shows a consent page naming the connecting client, where its access will be sent, your account and the scopes it asks for; the scoped MCP access token is issued only after you choose **Allow** (**Deny** returns `access_denied` to the client). A raw FAS session token is not accepted as a Bearer token; connect through OAuth.

Write tools (`create_app`, `update_files`) additionally verify app ownership via the backend `/v1/apps/mine` endpoint. Agent tools (`agent_build`) require a usable AI key in your vault or a supported platform-configured provider connection. The selected provider controls availability and charges.

## Security

- **Scoped tokens**: write tools verify ownership per-app, not blanket write access.
- **Read-only mode**: server-wide only. When the Worker runs with `MCP_READ_ONLY=1`, every non-read tool (`create_app`, `update_files`, `agent_build`) is refused for all users. There is no per-session read-only switch; to keep a client to reads, grant it only the `read` scope.
- **Dry-run**: pass `dry_run: true` to `create_app` or `update_files` to validate inputs, check ownership, and preview what would happen — without executing.
- **Audit logging**: `create_app`, `update_files` and `agent_build` record each success, dry-run, error and denial (including scope and read-only denials) as a redacted event in KV, keyed to your account and kept for 90 days. Read your own events with the `mcp_audit_log` tool.
- **Session isolation**: `agent_build` sessions are namespaced per user; you cannot read or target another user's session.
- **No generic shell/API proxy**: every tool has a specific, bounded purpose.
- **OAuth rate limiting**: token endpoint returns 429 on abuse.
- **Backend is the auth authority**: MCP does not hold signing keys; all auth decisions are delegated to the FAS backend.

## Local AI access to app data (FreeAppStore desktop)

AI clients work on an app's data through the **FreeAppStore desktop app**, not through a server: the app's
data stays on the device ([download the desktop app](https://freeappstore.online/download)). The desktop app runs a loopback MCP server at `http://127.0.0.1:47821/mcp`,
protected by a per-install token. Its home screen shows the exact setup command:

```bash
claude mcp add --transport http fas http://127.0.0.1:47821/mcp --header "Authorization: Bearer <token>"
```

| Tool | Description |
|------|-------------|
| `list_open_apps` | Apps open with AI access on: app id, title, desktop window or browser tab, tool names |
| `app_tools` | One open app's tools, with descriptions and JSON Schemas |
| `app_call` | Run one of an open app's tools on its local data |
| `open_app` | Open an app in a desktop window and wait for its tools |

An app offers tools with `exposeTools` from `@freeappstore/sdk/bridge`:

```ts
import { exposeTools } from '@freeappstore/sdk/bridge';

const bridge = exposeTools({
  enabled: allowAi, // the user's "Allow AI access" toggle
  tools: [
    {
      name: 'read_range',
      description: 'Read the cell values in a range such as A1:C10 on the active sheet.',
      inputSchema: {
        type: 'object',
        properties: { range: { type: 'string' } },
        required: ['range'],
      },
      handler: ({ range }) => sheet.read(range), // any JSON value; throw for an error
    },
  ],
  onStatus: setAiStatus, // 'off' | 'connecting' | 'connected' | 'rejected'
});
bridge.setEnabled(false); // when the user turns AI access off
```

- Inside the FreeAppStore desktop app the tools go over the window's IPC channel. In a browser tab they go to
  `ws://127.0.0.1:47821/bridge`, which only accepts `https://<id>.freeappstore.online` pages registering their
  own id `<id>`. Off that host (local dev) pass `appId`; the desktop app accepts `http://localhost:*` only in dev builds.
- Keep AI access off until the user turns it on, and make the toggle visible. The bridge reconnects quietly while
  enabled, so the app can be opened before or after the desktop app.
- Messages are capped at 1 MB and each call times out after 30 s: return summaries or ranges, not whole datasets.
- Tool errors reach the AI as-is, so write them as instructions ("Sheet \"Q4\" does not exist. Sheets: Q1, Q2.").
- The data stays on the device: the desktop app relays calls on this computer only, and nothing goes to a
  FreeAppStore server. Desktop windows and browser tabs keep separate local data.

Running and building the desktop app: [`desktop/README.md`](https://github.com/freeappstore-online/platform/blob/main/desktop/README.md).

## Alternative: SKILLS.md

For agents that don't support MCP, point them at the full platform guide:

```
https://freeappstore.online/skills.md
```

This contains the complete tech stack, SDK reference, CLI docs, deploy flow, compliance rules, and code examples.
