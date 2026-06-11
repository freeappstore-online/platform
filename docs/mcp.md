# MCP Server

Connect an AI agent (Claude Code, Cursor, etc.) to FreeAppStore via MCP.

## Setup

Add to your MCP config:

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

## Available tools

### Inspection (no auth required)

| Tool | Description |
|------|-------------|
| `list_apps` | List all published apps |
| `app_info` | Get details about a specific app |
| `deploy_status` | Check deployment status |
| `app_logs` | View recent deploy logs |
| `platform_guide` | Get the full SKILLS.md platform guide |
| `sdk_reference` | Get SDK documentation |

### Read (no auth required)

| Tool | Description |
|------|-------------|
| `list_files` | List files in an app's repo |
| `read_file` | Read a specific file from an app's repo |

### Write (requires FAS token + app ownership)

| Tool | Description |
|------|-------------|
| `create_app` | Create a new app |
| `update_files` | Update files in an app's repo |

### Agent (requires FAS token)

| Tool | Description |
|------|-------------|
| `agent_build` | Trigger an AI agent build session |
| `agent_status` | Check agent build status |

## Alternative: SKILLS.md

For agents that don't support MCP, point them at the full platform guide:

```
https://freeappstore.online/skills.md
```

This contains the complete tech stack, SDK reference, CLI docs, deploy flow, compliance rules, and code examples.
