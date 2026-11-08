# FreeAppStore MCP Server

Remote MCP server for AI agents to interact with the FreeAppStore platform.

- Endpoint: `mcp.freeappstore.online/mcp`
- Dev: `npm install && npm run dev`
- Deps: `@modelcontextprotocol/sdk` is pinned to the exact version `agents` depends on, so the
  tree holds ONE copy (two copies make `FasMcpAgent.server` fail to type-check). When bumping
  `agents`, re-pin the SDK to match. `.npmrc` sets `legacy-peer-deps` because `agents` declares
  react/ai-sdk peers a Worker never needs; `npm ci` reads it too, so local and CI resolve alike.
- Deploy: `git push origin main` (auto-deploys via GitHub Actions)

## Tools

**Build it yourself — the CALLING model writes the code, MCP ships it (auth + ownership):**

| Tool | Auth | Description |
|------|------|-------------|
| `create_app` | FAS token | Provision repo+hosting+listing, scaffold the current starter (same generator as `fas init`, `src/scaffold.ts`), push. Not live until `update_files` replaces the starter screen and a deploy is green; a failed run resumes by calling it again. The `fas init`+`publish`+push loop, server-side. `update_files` runs the shared source preflight (`src/preflight.ts`) and refuses a push that would break the build. |
| `update_files` | owner | Write/overwrite files in your app's repo → auto-deploys in ~30-60s. The improve loop. |
| `read_file` | None | Read a file from an app's (public) repo |
| `list_files` | None | List files in an app's (public) repo |

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
| `platform_guide` | None | Fetch SKILLS.md (full platform guide), then the current build rules |
| `sdk_reference` | None | SDK reference: `shell` and `components` first, then auth, kv, counters, collections, rooms, proxy, keys, push, hooks, ui, free-apis |

**SDK Shell is the supported default (#91).** For a new default scaffold, the output
teaches wrapping the app in `<Shell app={fas} nav={NAV}>` from `@freeappstore/sdk/ui` with a nav
item per screen, start screens with `PageHeader`, and use the SDK components. Custom accessible frames are supported by the composable
starter contract; preserve app-owned choices instead of replacing their layouts. The text lives in `src/sdk-reference.ts` (`BUILD_HANDOFF_BLOCK`, the `shell` and
`components` sections); `create_app` (dry run and result) and `platform_guide` return the hand-off.
When the SDK's UI exports or Shell props change, update `sdk-reference.ts`;
`sdk-reference.test.ts` fails until the `components` list matches `packages/sdk/src/ui/index.ts`.

**Every tool is registered with `server.registerTool` and carries a `title` plus explicit
`readOnlyHint` / `destructiveHint` / `openWorldHint` booleans** (presets `READ`, `WRITE`,
`OVERWRITE` in `src/index.ts`). The Claude Connectors Directory and the ChatGPT Apps Directory
reject tools without them (#539), and `npm run test:runtime` fails the build if one is missing.
Keep descriptions factual — say what the tool does, never instruct the model how to behave;
build guidance belongs in the returned content.

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

## Delivery mode

**Straight to `main`. No branches, no pull requests.** Declared 2026-08-16.

**No branches. No pull requests. Ever.**
Commit directly to `main`. Do not run `git checkout -b`, `git switch -c`, or `gh pr create`. If you
find yourself on a non-`main` branch, stop and report it. (Declared 2026-08-16.)
