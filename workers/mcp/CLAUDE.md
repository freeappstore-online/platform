# FreeAppStore MCP Server

Remote MCP server for AI agents to interact with the FreeAppStore platform.

- Endpoint: `mcp.freeappstore.online/mcp`
- Dev: `npm install && npm run dev`
- Deploy: `git push origin main` (auto-deploys via GitHub Actions)

## Tools

**Build it yourself — the CALLING model writes the code, MCP ships it (auth + ownership):**

| Tool | Auth | Description |
|------|------|-------------|
| `create_app` | FAS token | Provision repo+hosting+listing, scaffold a template, push → live at `<id>.freeappstore.online`. The `fas init`+`publish`+push loop, server-side. |
| `update_files` | owner | Write/overwrite files in your app's repo → auto-deploys in ~30-60s. The improve loop. |
| `read_file` | None | Read a file from an app's repo |
| `list_files` | None | List files in an app's repo |

**Or let the platform's VibeCode AGENT write the code — you just prompt:**

| Tool | Auth | Description |
|------|------|-------------|
| `agent_build` | FAS token | Hand a natural-language prompt to the VibeCode agent (`agent.freeappstore.online`); it writes the code AND deploys, using your **vaulted AI key** (provider must be in your vault, e.g. anthropic). Long-running; returns a `session_id`. |
| `agent_status` | FAS token | Poll an `agent_build` session — app id, deploy phase, live URL. |

Note: `create_app`/`update_files` need no AI key (the client model is the author);
`agent_build` needs a funded key in your FreeAppStore vault for the chosen provider.

**Info / inspect:**

| Tool | Auth | Description |
|------|------|-------------|
| `list_apps` | FAS token | List your published apps |
| `app_logs` | owner | Recent errors/warnings/SDK calls/build info |
| `deploy_status` | None | Check GitHub Actions deploy status |
| `app_info` | None | Get app URLs, repo, status |
| `platform_guide` | None | Fetch SKILLS.md (full platform guide) |
| `sdk_reference` | None | SDK reference (auth, kv, counters, collections, rooms, proxy, keys, email, webhooks, roles, ui) |

Write tools require the `GITHUB_TOKEN` secret (org token with contents:write) on the
worker; writes are gated by verified app ownership (`/v1/apps/mine`). `create_app`
provisions via the backend `/v1/publish` (same path as `fas publish`) with the
caller's session, then pushes the scaffolded template via the GitHub Git Data API.

## Connect from Claude Code

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
