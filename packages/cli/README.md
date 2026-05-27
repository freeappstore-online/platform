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
| `fas init <app-id>` | Scaffold a new free app or game from a platform template. Replaces `APPNAME` placeholders, runs `git init`, makes the first commit. |
| `fas check` | Run compliance checks (no-tracking, brand fonts, manifest, bundle size). Exits non-zero on hard failures. |
| `fas publish` | Provisions repo + hosting route + storefront entry, injects `deploy.yml` if missing, then prints `git remote add` and `git push` instructions. Auto-runs `fas check` first. |
| `fas list` (alias `fas ls`) | List apps and games you have published. `--json` for scripting, `-v` for recent commits. |
| `fas logs <app-id>` | Tail live deployment logs for an app's Cloudflare Pages project. |
| `fas secret set\|list\|rm` | Manage server-side encrypted API keys for an app. |
| `fas proxy allow\|list\|deny` | Manage the URL allowlist for the per-app secret-injecting proxy. |
| `fas screencheck` | Build the app and run a headless browser at every reference viewport to verify the layout fits without scrolling. |
| `fas quality [app-id]` | Show the VCQA code quality report (score + grade) for an app. |

---

### `fas login`

Sign in with GitHub via the device-authorization flow. Opens a browser to authorize the CLI, then exchanges the GitHub token for a platform session token. Both are persisted to `~/.fas/config.json` (mode `0600`).

```bash
fas login
```

### `fas logout`

Clear the cached GitHub access token and platform session token.

```bash
fas logout
```

### `fas whoami`

Print the GitHub login of the currently signed-in user. Exits non-zero if not authenticated.

```bash
fas whoami
# @yourname
```

### `fas doctor`

Run local health checks: Node version, git, pnpm, config file, signed-in state, and API reachability.

```bash
fas doctor
```

### `fas init <app-id>`

Scaffold a new free app or game from a platform template. Clones the template repo, substitutes all `APPNAME` placeholders with the given id, and creates the first git commit.

```bash
fas init my-app                        # default: standalone template
fas init my-app --template connected   # uses platform backend (KV, rooms, etc.)
fas init asteroids --template game-canvas  # HTML5 canvas game template
```

| Flag | Purpose |
|---|---|
| `-t, --template <name>` | Template to use. Choices: `standalone`, `connected`, `game-canvas`, `game-grid`, `game-3d`. Default: `standalone`. |

### `fas check`

Run compliance checks against the app in the current directory (or `--dir`). Checks include: no tracking SDKs, brand fonts present, no brand token overrides, PWA manifest valid, bundle size under limit, and no leftover `APPNAME` placeholders. Exits non-zero on hard failures.

```bash
fas check              # check cwd
fas check --dir ../my-app
```

| Flag | Purpose |
|---|---|
| `--dir <path>` | Repo directory to check. Defaults to cwd. |

### `fas publish`

Provision and publish an app to FreeAppStore (or FreeGameStore). Runs compliance checks, authenticates, creates a GitHub repo + R2 hosting route + storefront registry entry via the admin Worker, and injects a deploy workflow.

By default, `publish` is interactive — it asks for category, type, oneliner, and demo URL. Skip prompts by passing flag values; combine with `--yes` to fail fast in CI rather than hang on a missing field.

```bash
fas publish                          # interactive
fas publish --store games            # publish to FreeGameStore instead
fas publish \
  --name my-app \
  --category Utilities \
  --type standalone \
  --oneliner "Does the thing." \
  --yes                              # non-interactive (CI)
```

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

### `fas list` (alias `fas ls`)

List apps and games you have published. Shows app id, category, live URL, and creation date.

```bash
fas list               # human-readable table
fas list --json        # full JSON with per-app commit history
fas list -v            # verbose — show last 3 commits per app
```

| Flag | Purpose |
|---|---|
| `--json` | Output JSON instead of a table (includes per-app commit history). |
| `-v, --verbose` | Show recent commits per app (fetches last 3 from each app repo via GitHub API). |

### `fas logs <app-id>`

Tail live deployment logs for an app's Cloudflare Pages project. Requires `wrangler` to be installed globally.

```bash
fas logs calculator
fas logs calculator --cf-project freecalculator
```

| Flag | Purpose |
|---|---|
| `--cf-project <name>` | Override the Cloudflare Pages project name (auto-derived by default). |

### `fas secret set|list|rm`

Manage server-side encrypted API keys for an app. Secrets are stored on the platform and injected at runtime via the proxy. Values are encrypted at rest; `list` only shows names, never values.

```bash
fas secret set OPENWEATHER_KEY sk-abc123         # store a secret
fas secret set OPENWEATHER_KEY sk-abc123 --app my-app  # explicit app id
fas secret list                                  # list secret names
fas secret list --json                           # machine-readable
fas secret rm OPENWEATHER_KEY                    # delete a secret
```

| Subcommand | Usage | Description |
|---|---|---|
| `set` | `fas secret set <name> <value> [--app <id>]` | Store or replace an encrypted API key. Name must be uppercase + underscores. |
| `list` (alias `ls`) | `fas secret list [--app <id>] [--json]` | List secret names registered for an app. |
| `rm` (alias `remove`) | `fas secret rm <name> [--app <id>]` | Delete a stored secret. |

All subcommands accept `--app <id>` to specify the app explicitly. If omitted, the app id is derived from the `name` field in the current directory's `package.json`.

### `fas proxy allow|list|deny`

Manage the URL allowlist for the per-app secret-injecting proxy. The proxy intercepts outbound API calls from your app and injects the appropriate secret (as a query param, header, bearer token, or OAuth2 client credentials exchange) so that API keys never reach the browser.

```bash
# Allow the proxy to inject OPENWEATHER_KEY as a query param when calling the API
fas proxy allow "https://api.openweathermap.org/" \
  --secret OPENWEATHER_KEY \
  --inject "query:appid"

# Inject as a Bearer token
fas proxy allow "https://api.example.com/v1/" \
  --secret EXAMPLE_TOKEN \
  --inject bearer

# OAuth2 client credentials flow
fas proxy allow "https://api.spotify.com/v1/" \
  --secret SPOTIFY_CLIENT_ID \
  --secret2 SPOTIFY_CLIENT_SECRET \
  --inject oauth2_cc \
  --token-url "https://accounts.spotify.com/api/token"

# List current rules
fas proxy list
fas proxy list --json

# Remove a rule
fas proxy deny "https://api.openweathermap.org/"
```

| Subcommand | Usage | Description |
|---|---|---|
| `allow` | `fas proxy allow <pattern> --secret <name> --inject <spec> [flags]` | Add an allowlist rule. `<pattern>` is a URL prefix (must start with `https://`). |
| `list` (alias `ls`) | `fas proxy list [--app <id>] [--json]` | Show all proxy allowlist rules for the app. |
| `deny` (alias `rm`) | `fas proxy deny <pattern> [--app <id>]` | Remove an allowlist rule by its exact pattern. |

**`allow` flags:**

| Flag | Purpose |
|---|---|
| `--secret <name>` | **(required)** Name of a previously stored secret (see `fas secret set`). |
| `--inject <spec>` | **(required)** How to inject: `query:<name>`, `header:<name>`, `bearer`, or `oauth2_cc`. |
| `--secret2 <name>` | Second secret (the `client_secret` for `oauth2_cc`). |
| `--token-url <url>` | OAuth2 token endpoint (required for `oauth2_cc`). |
| `--methods <list>` | Comma-separated HTTP methods. Default: `GET`. |
| `--app <id>` | App id (defaults to `package.json` name in cwd). |

### `fas screencheck`

Build the app and run a headless Chromium browser at every reference viewport in the device matrix (portrait + landscape, from iPhone SE to iPad Pro). Reports whether the layout fits without scrolling or clipping, and computes device coverage percentages. Requires Playwright as a dev dependency in the app project.

```bash
fas screencheck                       # build + test local dist
fas screencheck --skip-build          # test existing dist without rebuilding
fas screencheck --screenshots         # save a PNG per viewport to ./screencheck-out/
fas screencheck --url https://my-app.freeappstore.online  # test a live deployment
```

| Flag | Purpose |
|---|---|
| `--dir <path>` | Repo directory to check. Defaults to cwd. |
| `--port <n>` | Port for the local static server. Default: `4571`. |
| `--skip-build` | Skip `pnpm build` -- assume `web/dist` is already current. |
| `--screenshots` | Save a PNG of every viewport to `./screencheck-out/`. |
| `--url <url>` | Check a live URL instead of building and serving locally. |

### `fas quality [app-id]`

Show the VCQA (VibeCode QA) code quality report for an app. Fetches the latest report from the platform API and displays the composite score (0--100), letter grade (A--F), per-check breakdown, and top issues.

If `app-id` is omitted, the command auto-detects it from the current directory's `package.json` name, a `*.freeappstore.online` reference in `CLAUDE.md`, or the directory basename.

```bash
fas quality                  # auto-detect app id from cwd
fas quality timer            # explicit app id
fas quality timer --json     # raw JSON for scripting
```

| Flag | Purpose |
|---|---|
| `--json` | Output the raw JSON report instead of the formatted summary. |

## Configuration

| Env var | Purpose |
|---|---|
| `FAS_API_BASE` | Override the API base URL. Defaults to `https://api.freeappstore.online`. Useful for local dev (`http://localhost:8787`). |
| `NO_COLOR` | Set to `1` to disable ANSI colors in output. |

`~/.fas/config.json` (mode `0600`) holds the GitHub OAuth token + the platform session token. `fas logout` deletes both.

## Brand and UI rules (mandated)

Every app and game on the platform shares the same visual language — colors, fonts, spacing — so the storefront and detail pages stay predictable. `fas check` enforces:

| Check | Rule |
|---|---|
| `No template placeholders` | Every `APPNAME` placeholder substituted before publish. |
| `No tracking SDKs` | None of 8 known trackers (Google Analytics, Plausible, Mixpanel, …). |
| `Brand fonts present` | Manrope (body) + Fraunces (display) both referenced in CSS / HTML. |
| `No brand overrides` | No app redefines a platform CSS token (`--paper`, `--ink`, `--accent`, `--line`, `--line-strong`, `--panel`, `--muted`) outside the canonical theme file; no non-brand `font-family` declarations. |
| `PWA manifest` | `web/public/manifest.json` with `name`, `display`, `start_url`. |
| `Bundle size` | Main bundle under 300 KB gzipped. |

`fas publish` auto-runs `fas check` and aborts on hard failures (override with `--skip-checks`, admin review will still catch issues).

## How `fas publish` works

1. **Compliance gate**: runs the same checks as `fas check`. Hard failures abort.
2. **Auth check**: confirms a valid session token (re-login if expired).
3. **Provision**: POSTs to the platform API, which calls the admin Worker via service binding. Admin creates an empty GitHub repo, inserts a D1 hosting route (subdomain → R2 prefix), and appends the app to the storefront registry.
4. **Deploy workflow**: injects `.github/workflows/deploy.yml` locally if missing, so the first `git push` triggers an R2 deploy.
5. **Ownership**: records the app in the platform DB so `fas list` returns it.
6. **Output**: prints the live URL, repo URL, storefront listing URL, and the `git remote add` + `git push` commands to populate the new repo.

If auto-provision is unavailable (503 from the API), `publish` falls back to opening a prefilled GitHub Issue form for maintainer review. Use `--issue` to force this path.

## For AI Agents

Building with Claude Code, Cursor, or another AI tool? Connect the MCP server for tool-based access:

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

Or read the full platform guide: [freeappstore.online/skills.md](https://freeappstore.online/skills.md)

## License

MIT.
