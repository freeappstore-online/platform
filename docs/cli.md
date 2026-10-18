# CLI Reference

`@freeappstore/cli` -- the `fas` command-line tool for scaffolding, checking, and publishing apps.

```bash
npm i -g @freeappstore/cli
```

Requires Node 22+.

## Commands

| Command | Description |
|---------|-------------|
| `fas` | Launch the interactive TUI (when stdout is a TTY) |
| `fas login` | Sign in with GitHub (device-flow auth) |
| `fas logout` | Clear cached session |
| `fas whoami` | Print current GitHub login |
| `fas doctor` | Health check -- Node, git, pnpm, config, API reachability |
| `fas init <id>` | Scaffold a new app from a template |
| `fas check` | Run compliance checks |
| `fas publish` | Provision repo + hosting + DNS and publish |
| `fas list` | List your published apps |
| `fas logs <id>` | Tail deploy logs (GitHub Actions) |
| `fas secret set\|list\|rm` | Manage app API keys |
| `fas proxy allow\|list\|deny` | Manage proxy URL allowlist |
| `fas screencheck` | Responsive layout test across viewports |
| `fas quality [id]` | VCQA code quality report |
| `fas admin transfer-owner` | Admin-only ownership transfer (compare-and-set) |

## `fas login`

Signs in with GitHub via device-authorization flow. Opens a browser to authorize, exchanges the token for a platform session. Both are cached at `~/.fas/config.json` (mode `0600`).

## `fas init <app-id>`

Scaffolds a new app from a platform template.

```bash
fas init my-app                          # standalone (default)
fas init my-app --template connected     # uses platform backend
fas init asteroids --template game-canvas
```

| Flag | Purpose |
|------|---------|
| `-t, --template <name>` | `standalone`, `connected`, `game-canvas`, `game-grid`, `game-3d` |

Both app templates start inside the SDK `Shell` with real `nav` items: `standalone` has
Home and About and no sign-in; `connected` has Home and Account behind the sign-in gate
(`requireAuth`). See [Templates](getting-started.md#templates).

## `fas check`

Runs compliance checks against the app in the current directory.

| Check | Rule |
|-------|------|
| No template placeholders | Every `APPNAME` substituted |
| No tracking SDKs | 8 known trackers blocked |
| Brand fonts present | Manrope + Fraunces referenced |
| No brand overrides | No redefined platform CSS tokens |
| PWA manifest | Valid `manifest.json` with name, display, start_url |
| Bundle size | Under 300KB gzipped |

## `fas publish`

Provisions and publishes your app. Runs `fas check` first.

```bash
fas publish                    # interactive
fas publish --store games      # publish to FreeGameStore
fas publish --yes              # non-interactive (CI)
```

| Flag | Purpose |
|------|---------|
| `--name <id>` | App id (defaults to `package.json` name) |
| `--category <name>` | Storefront category |
| `--type standalone\|connected` | App type |
| `--oneliner <text>` | One-line description |
| `--demo <url>` | Demo URL |
| `--yes` | Non-interactive mode |
| `--issue` | Open GitHub Issue form instead of auto-provision |
| `--skip-checks` | Skip compliance checks (not recommended) |

## `fas admin transfer-owner <app>`

Move an app to a new owner. Admin session only. The transfer is refused unless `--from` is the owner recorded right now, and the refusal names that owner. Every successful transfer is written to an audit record (who, when, from, to, reason).

```bash
fas admin transfer-owner watertracker \
  --from mathanghial \
  --to serge-ivo \
  --reason "reuse the empty repo for wave 1"
```

| Flag | Purpose |
|------|---------|
| `--from <login>` | Current owner. Required. |
| `--to <login>` | New owner. Must be an existing account. Required. |
| `--reason <text>` | Stored on the audit row. Required. |
| `--json` | Print the response JSON. |

Undo is the same command with `--from` and `--to` swapped. `FAS_ADMIN_BASE` overrides the admin worker URL; otherwise it is derived from the API host (`api.` → `admin.`).

## `fas list`

```bash
fas list               # human-readable table
fas list --json        # JSON with commit history
fas list -v            # verbose -- last 3 commits per app
```

## `fas logs <app-id>`

Shows recent GitHub Actions deploy runs. Status, timestamps, and links to failed runs.

## `fas secret`

Manage server-side encrypted API keys.

```bash
fas secret set OPENWEATHER_KEY sk-abc123
fas secret set OPENWEATHER_KEY sk-abc123 --app my-app
fas secret list
fas secret list --json
fas secret rm OPENWEATHER_KEY
```

## `fas proxy`

Manage the URL allowlist for the secret-injecting proxy.

```bash
fas proxy allow "https://api.openweathermap.org/" \
  --secret OPENWEATHER_KEY --inject "query:appid"

fas proxy allow "https://api.example.com/v1/" \
  --secret EXAMPLE_TOKEN --inject bearer

fas proxy allow "https://api.spotify.com/v1/" \
  --secret SPOTIFY_CLIENT_ID --secret2 SPOTIFY_CLIENT_SECRET \
  --inject oauth2_cc --token-url "https://accounts.spotify.com/api/token"

fas proxy list
fas proxy deny "https://api.openweathermap.org/"
```

Injection modes: `query:<name>`, `header:<name>`, `bearer`, `oauth2_cc`.

## `fas screencheck`

Headless browser test across all reference viewports (iPhone SE to iPad Pro).

```bash
fas screencheck                      # build + test
fas screencheck --skip-build         # test existing dist
fas screencheck --screenshots        # save PNGs
fas screencheck --url https://my-app.freeappstore.online
```

## `fas quality`

```bash
fas quality            # auto-detect app from cwd
fas quality timer      # explicit app id
fas quality timer --json
```

## Configuration

| Env var | Purpose |
|---------|---------|
| `FAS_API_BASE` | Override API base URL (default: `https://api.freeappstore.online`) |
| `NO_COLOR` | Disable ANSI colors |
