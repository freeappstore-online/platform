# @freeappstore/cli

The `fas` CLI for FreeAppStore creators.

## Install

```bash
npm i -g @freeappstore/cli
```

## Commands

| Command | What it does |
|---|---|
| `fas login` | Sign in with GitHub via the device-authorization flow. Token cached at `~/.fas/config.json`. |
| `fas whoami` | Print the currently signed-in GitHub login. |
| `fas init <app-id> [--template standalone\|connected]` | Scaffold a new free app from one of the platform templates. |
| `fas publish` | Open the FreeAppStore publisher portal for the current repo (detected from `.git/config`). Pass `--no-open` to print the URL instead. |
| `fas logs <app-id>` | Tail the live logs for an app's Cloudflare Pages project (shells to `wrangler pages deployment tail`). |

## Configuration

| Env var | Purpose |
|---|---|
| `FAS_API_BASE` | Override the API base URL. Defaults to `https://api.freeappstore.online`. Useful for local dev (`http://localhost:8787`). |
| `FAS_GITHUB_CLIENT_ID` | GitHub OAuth App client_id used by `fas login`. The platform-released CLI bakes this in; override only if you're testing a private build. |

## How `fas publish` works

It does **not** call a custom API. It opens the existing publisher portal at `https://publish.freeappstore.online` with the current repo as a query param, and the portal handles the rest (CF Pages project creation, DNS, registry update). This keeps `fas` thin — the portal is the source of truth for provisioning.

## License

MIT.
