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
| `sdk_reference` | None | SDK docs. Start with `shell` (the standard app frame), then `components` (every UI component); also auth, KV, counters, collections, rooms, proxy, hooks |
| `platform_guide` | None | Fetch full SKILLS.md, followed by the current app-building rules |
| `list_apps` | FAS token | List your published apps |

### Building apps: the Shell comes first

An AI building over this server learns the standard app frame from the tool output
(`src/sdk-reference.ts`, #91). `create_app` and `platform_guide` end with the same build
hand-off, and `sdk_reference` leads with it:

1. Wrap the whole app in `<Shell app={fas} appName="My App" nav={NAV} onNavigate={navigate}>` from
   `@freeappstore/sdk/ui`, with a `nav` entry per screen. The Shell renders the topbar and
   `<nav aria-label="Main">`, plus the error boundary, toasts, offline banner and skip link.
2. Start each screen with `PageHeader`, and build it from the SDK components.
3. No hand-rolled header, sidebar or dock, and no subscription or upgrade screen (FreeAppStore is
   free). `requireAuth` only when the whole app needs sign-in.

`src/sdk-reference.test.ts` keeps this true: the `components` section is checked against the
SDK's `packages/sdk/src/ui/index.ts` exports, and the tools are pinned to return the hand-off.

## Discovery

- MCP Registry: [`io.github.freeappstore-online/mcp`](https://registry.modelcontextprotocol.io)
- Auto-discovery: [`freeappstore.online/.well-known/mcp.json`](https://freeappstore.online/.well-known/mcp.json)
- Platform guide: [`freeappstore.online/llms.txt`](https://freeappstore.online/llms.txt)
- Docs: [`freeappstore.online/docs/mcp`](https://freeappstore.online/docs/mcp)

## Architecture

Cloudflare Worker with a SQLite-backed Durable Object (`FasMcpAgent`), using the [`agents`](https://www.npmjs.com/package/agents) SDK. Deployed via GitHub Actions.

Every request passes a per-IP rate limit (`MCP_RATE_LIMIT`, 120 requests / 60 s, `src/ratelimit.ts`) before OAuth or routing; over the limit it returns `429` with `Retry-After`. It is enforced under `wrangler dev`, but was not observed tripping in production as of 2026-09-26. It also cannot cap Workers request usage, since the Worker still runs; that needs an edge WAF rule on `mcp.*` (#68).

Sign-in is OAuth 2.1 to MCP clients and a PKCE `response_mode=code` login against the FAS backend: see [docs/oauth-pkce-setup.md](docs/oauth-pkce-setup.md), which also covers scopes and how another store can copy the pattern.

## Development

```bash
npm install
npm run dev    # local dev server
npm run deploy # deploy to CF Workers
```

## License

MIT.
