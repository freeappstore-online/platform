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

### Build — write code yourself (auth required)

| Tool | Description |
|------|-------------|
| `create_app` | Provision repo + hosting + listing, scaffold template, deploy live at `<id>.freeappstore.online` |
| `update_files` | Write/overwrite files in an app you own; auto-redeploys in ~30-60s |

### Build — let the VibeCode agent write code (auth + vaulted AI key)

| Tool | Description |
|------|-------------|
| `agent_build` | Hand a prompt to the VibeCode agent; it writes the code and deploys it |
| `agent_status` | Poll an agent_build session for progress and live URL |

### Read (no auth required)

| Tool | Description |
|------|-------------|
| `list_files` | List files in an app's repo |
| `read_file` | Read a specific file from an app's repo |

### Inspect

| Tool | Auth | Description |
|------|------|-------------|
| `list_apps` | FAS token | List your published apps |
| `app_info` | None | Live URL, repo, store listing, up/down status |
| `deploy_status` | None | Check last 5 GitHub Actions runs |
| `app_logs` | Owner | Recent errors, warnings, SDK calls, build info |
| `platform_guide` | None | Fetch full SKILLS.md platform guide |
| `sdk_reference` | None | SDK reference (auth, kv, counters, collections, rooms, proxy, keys, ui) |

## Workflow Recipes

### Create and deploy a new app

```
"Create a todo app and deploy it."
Expected tool flow:
1. create_app       → provisions repo + hosting + listing, scaffolds template
2. list_files       → see the scaffolded template files
3. read_file        → read web/src/App.tsx
4. update_files     → write your app code (auto-deploys)
5. deploy_status    → confirm it went live
```

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
1. agent_build      → VibeCode agent writes + deploys (uses your vaulted AI key)
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

**Read** (no auth):
- App metadata (info, listing, status)
- Deploy history (GitHub Actions runs)
- File tree and file contents (public repos)
- Platform guide (SKILLS.md)
- SDK reference docs

**Read** (auth required):
- Your published app list
- App logs (errors, warnings, SDK calls)

**Write** (auth + app ownership):
- Create new apps (provision + scaffold + deploy)
- Update files in apps you own (auto-redeploys)

**Agent** (auth + vaulted AI key):
- Trigger VibeCode agent builds
- Poll agent build status

**Not supported via MCP:**
- Deleting apps or repos
- DNS or domain configuration
- Billing or subscription changes
- User account management
- Platform compliance rule changes
- Direct database (D1/KV) access

## Authentication

The MCP server supports two auth methods:

1. **OAuth 2.1** (automatic via `mcp-remote`) — recommended. The OAuth flow redirects to GitHub sign-in and provisions a scoped access token.
2. **Bearer token** — pass a FAS session token directly via `Authorization: Bearer <token>`.

Write tools (`create_app`, `update_files`) additionally verify app ownership via the backend `/v1/apps/mine` endpoint. Agent tools (`agent_build`) require a funded AI key in your FreeAppStore vault.

## Security

- **Scoped tokens**: write tools verify ownership per-app, not blanket write access.
- **Read-only mode**: send `X-FAS-Read-Only: true` header or `?read_only=1` query param to block all write tools (`create_app`, `update_files`, `agent_build`). Useful for CI, auditing, or browse-only integrations.
- **Dry-run**: pass `dry_run: true` to `create_app` or `update_files` to validate inputs, check ownership, and preview what would happen — without executing.
- **Audit logging**: all write tool calls emit structured JSON logs (tool, userId, timestamp, params) to CF Worker logs / Logpush.
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
