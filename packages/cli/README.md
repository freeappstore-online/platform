# @freeappstore/cli

The `fas` CLI for [FreeAppStore](https://freeappstore.online) creators. Scaffold, check, publish, and manage your free apps.

## Install

```bash
npm i -g @freeappstore/cli
```

Requires Node 22+.

## Quick start

```bash
fas login              # GitHub device-flow auth
fas init my-app        # scaffold from the standalone template
cd my-app
pnpm install && pnpm dev
fas check              # compliance checks
fas publish            # provisions repo + hosting + DNS
git push upstream main # auto-deploys via CI
```

Live in 30 seconds at `https://my-app.freeappstore.online`.

## Commands

| Command | What it does |
|---|---|
| `fas` | Launch the interactive TUI (when stdout is a TTY). Falls back to `--help` otherwise. |
| `fas login` | Sign in with GitHub via the device-authorization flow. Token cached at `~/.fas/config.json` (`0600`). |
| `fas logout` | Clear the cached session. |
| `fas whoami` | Print the currently signed-in GitHub login. |
| `fas doctor` | Health check — Node version, git, pnpm, config, signed-in state, API reachability. |
| `fas init <app-id> [--template standalone\|connected]` | Scaffold a new free app from a platform template. Replaces `APPNAME` placeholders, runs `git init`, makes the first commit. |
| `fas check [--dir <path>]` | Run compliance checks (no-tracking, brand fonts, manifest, bundle size). Exits non-zero on hard failures. |
| `fas publish` | Provisions repo + Cloudflare Pages project + DNS + storefront entry, then prints `git remote add` and `git push` instructions. Auto-runs `fas check` first. |
| `fas list` (alias `fas ls`) | List apps you've published. `--json` for scripting. |
| `fas logs <app-id>` | Tail the live deployment logs for an app's Cloudflare Pages project. |

## `fas publish` flags

By default, `publish` is interactive — it asks for category, type, oneliner, and demo URL. Skip prompts by passing flag values; combine with `--yes` to fail fast in CI rather than hang on a missing field.

| Flag | Purpose |
|---|---|
| `--name <id>` | App id (lowercase, used as subdomain). Defaults to `package.json#name`. |
| `--category <name>` | Storefront category. Case-insensitive (e.g. `utilities`, `brain training`). |
| `--type standalone\|connected` | Standalone (localStorage only) or Connected (uses platform backend). |
| `--oneliner <text>` | One-line description shown on the storefront. |
| `--demo <url>` | Optional demo URL. Pass `""` to clear. |
| `--yes` | Non-interactive: missing required fields abort instead of prompting. |
| `--issue` | Skip auto-provision; open the GitHub Issue submission form instead. |
| `--skip-checks` | Skip `fas check` before publish (not recommended). |

Example for CI:

```bash
fas publish \
  --name my-app \
  --category Utilities \
  --type standalone \
  --oneliner "Does the thing." \
  --yes
```

## Configuration

| Env var | Purpose |
|---|---|
| `FAS_API_BASE` | Override the API base URL. Defaults to `https://api.freeappstore.online`. Useful for local dev (`http://localhost:8787`). |
| `NO_COLOR` | Set to `1` to disable ANSI colors in output. |

`~/.fas/config.json` (mode `0600`) holds the GitHub OAuth token + the platform session token. `fas logout` deletes both.

## How `fas publish` works

1. **Compliance gate**: runs the same checks as `fas check`. Hard failures abort.
2. **Auth check**: confirms a valid session token (re-login if expired).
3. **Provision**: POSTs to the platform API, which calls the admin Worker via service binding. Admin creates an empty GitHub repo, sets up the Cloudflare Pages project, adds a custom domain + DNS record, and appends the app to the storefront registry.
4. **Ownership**: records the app in the platform DB so `fas list` returns it.
5. **Output**: prints the live URL, repo URL, storefront listing URL, and the `git remote add` + `git push` commands to populate the new repo.

If auto-provision is unavailable (503 from the API), `publish` falls back to opening a prefilled GitHub Issue form for maintainer review. Use `--issue` to force this path.

## License

MIT.
