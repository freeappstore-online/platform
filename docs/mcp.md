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
| `sdk_reference` | Any | SDK reference. Start with `shell` (the standard app frame), then `components`; also auth, kv, counters, collections, rooms, proxy, keys, push, hooks, ui |
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

## Alternative: SKILLS.md

For agents that don't support MCP, point them at the full platform guide:

```
https://freeappstore.online/skills.md
```

This contains the complete tech stack, SDK reference, CLI docs, deploy flow, compliance rules, and code examples.
