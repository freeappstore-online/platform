# FreeAppStore MCP Server

Remote [MCP](https://modelcontextprotocol.io/) server for AI agents to interact with the [FreeAppStore](https://freeappstore.online) platform.

**Endpoint:** `https://mcp.freeappstore.online/mcp`

## Connect

### Claude Code

Add to `~/.claude.json`:

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

### Cursor

Settings > MCP > Add Server: `npx mcp-remote https://mcp.freeappstore.online/mcp`

### Any MCP client

Streamable HTTP transport at `https://mcp.freeappstore.online/mcp`

## Tools

| Tool | Auth | Description |
|------|------|-------------|
| `deploy_status` | None | Check last 5 GitHub Actions runs for any app |
| `app_info` | None | Live URL, repo, store listing, up/down status |
| `sdk_reference` | None | SDK docs for auth, KV, counters, collections, rooms, proxy, hooks, UI |
| `platform_guide` | None | Fetch full SKILLS.md (the complete platform guide) |
| `list_apps` | FAS token | List your published apps |

## Discovery

- MCP Registry: [`io.github.freeappstore-online/mcp`](https://registry.modelcontextprotocol.io)
- Auto-discovery: [`freeappstore.online/.well-known/mcp.json`](https://freeappstore.online/.well-known/mcp.json)
- Platform guide: [`freeappstore.online/llms.txt`](https://freeappstore.online/llms.txt)
- Docs: [`freeappstore.online/docs/mcp`](https://freeappstore.online/docs/mcp)

## Architecture

Cloudflare Worker with a SQLite-backed Durable Object (`FasMcpAgent`), using the [`agents`](https://www.npmjs.com/package/agents) SDK. Deployed via GitHub Actions.

## Development

```bash
npm install
npm run dev    # local dev server
npm run deploy # deploy to CF Workers
```

## License

MIT.
