# CLI Reference

`@freeappstore/cli` -- the `fas` command-line tool for scaffolding, checking, and publishing apps.

```bash
npm i -g @freeappstore/cli
```

Requires Node 22+.

Fresh app scaffolds include the versioned `pwa` capability. Existing apps can use
`fas add pwa --dry-run` and follow the generated integration instructions. See
[PWA lifecycle](pwa-lifecycle.md) for busy guards, optional downloads and offline limits.

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
| `fas build-target [--artifact] [--app-id <id>]` | Validate selected app entry, identity, build and release output |
| `fas publish` | Provision repo + hosting + DNS and publish |
| `fas list` | List your published apps |
| `fas logs <id>` | Show recent deploy runs (GitHub Actions) |
| `fas secret set\|list\|rm` | Manage app API keys |
| `fas proxy allow\|list\|deny` | Manage proxy URL allowlist |
| `fas screencheck` | Responsive layout test across viewports |
| `fas quality [id]` | VCQA code quality report |
| `fas admin transfer-owner` | Admin-only ownership transfer (compare-and-set) |

## `fas login`

Signs in with GitHub via device-authorization flow. Opens a browser to authorize, exchanges the token for a platform session. Both are cached at `~/.fas/config.json` (mode `0600`).

## `fas init <app-id>`

Init records the app identity and build target in `fas.json`, preserving template layout settings.
For an existing app or an alternate layout, configure repository-relative paths explicitly:

```json
{
  "appId": "taskflow",
  "applicationRoot": "apps/tasks",
  "outputPath": "release/tasks",
  "buildCommand": "pnpm --filter ./apps/tasks build"
}
```

`applicationRoot` contains `index.html`; `outputPath` contains the produced `index.html` and
JavaScript assets. Configure the bundler to emit that output; these settings do not rewrite
Vite configuration or move files. Defaults are `web`, `web/dist`, and `pnpm build`.
Without an explicit ID, legacy package names (including `@app-id/root`) supply the identity.
Use the provisioned ID, not `my-app` or an unresolved template placeholder.

`fas doctor` includes source build-target diagnostics. `fas publish` validates the target and
compares its ID with the requested publishing ID even with `--skip-checks`. Before uploading,
run `fas build-target --artifact --app-id <provisioned-id>`. Generated deployment CI resolves
the build command and upload path from the same configuration with `--github-output`, then
validates output before R2 upload. Existing custom workflows are preserved: align their build
and upload commands explicitly; a known literal upload-path mismatch is an error.

The validator follows local entry imports rather than searching every package for banned text.
Example/demo files are allowed. It diagnoses an excluded developed app when the selected entry
still contains starter UI, checks reachable literal SDK `initApp` identities, and checks release
HTML/JavaScript references for missing chunks and starter markers. Static tracing supports local
relative and root-relative imports; arbitrary aliases, computed imports and runtime identity
expressions still require a browser test. It does not prove arbitrary shell commands execute the
intended build. Use an explicit package filter or directory in custom build commands and smoke-test
a real feature in the output served by deployment. Scaffold CI serves the built artifact with
Vite preview and verifies an app-owned task counter, navigation and a theme change surviving reload.
The disposable smoke scaffold replaces starter instructions and adds that feature before building;
an untouched starter is intentionally rejected by the release-artifact check.

Scaffolds a new app from a platform template.

```bash
fas init my-app                          # standalone (default)
fas init my-app --template connected     # uses platform backend
fas init asteroids --template game-canvas
```

| Flag | Purpose |
|------|---------|
| `-t, --template <name>` | `standalone`, `connected`, `game-canvas`, `game-grid`, `game-3d` |

`standalone` and `connected` are generated from the same canonical foundation and
capability registry used by the builder and `fas add`. Both start inside the SDK
`Shell` with public Home and About navigation. `connected` adds a private draft
example whose own data is gated by sign-in; the rest of the app and Profile stay
available while signed out. `fas init --template standalone|connected` remains
supported. See the [composable starter contract](composable-starter-contract.md)
and [Templates](getting-started.md#templates).

## `fas check`

Runs compliance checks against the app in the current directory.

| Check | Rule |
|-------|------|
| No template placeholders | Every `APPNAME` substituted |
| No tracking SDKs | Known tracking SDKs blocked |
| No payments (free tier) | No Payment Request API, checkout SDKs or payment links |
| No ads | No ad network scripts, SDKs or packages |
| Brand fonts present | Manrope + Fraunces referenced |
| No brand overrides | No redefined platform CSS tokens |
| PWA manifest | Valid `manifest.json` with name, display, start_url |
| Bundle size | Initial-load JS under 300 KB gzipped; lazy wasm/workers under 25 MB each |

## `fas publish`

Provisions and publishes your app. Runs `fas check` first. If `fas.json` at the
repo root contains `"crossOriginIsolated": true`, the hosted origin gets COOP/COEP
headers so `SharedArrayBuffer` and threaded wasm work. Off by default; see
[Browser Capabilities](capabilities.md#cross-origin-isolation).

```bash
fas publish                    # interactive
fgs publish                  # use the separate FreeGameStore CLI for games
fas publish --yes              # non-interactive (CI)
```

| Flag | Purpose |
|------|---------|
| `--store apps` | Legacy selector; the FAS backend rejects games with 410. Use the separate `fgs` CLI for FreeGameStore. |
| `--name <id>` | App id (defaults to `package.json` name) |
| `--category <name>` | Storefront category |
| `--type standalone\|connected` | App type |
| `--oneliner <text>` | One-line description |
| `--demo <url>` | Demo URL |
| `--yes` | Non-interactive mode |
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

Browser layout check at the manifest's `min_viewport_width`, in portrait and landscape. Install the optional Playwright browser dependency when prompted.

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

## Optional first-party capabilities

Fresh Shell starters use SDK `^0.16.32` for the current compact header and Profile
appearance controls. That baseline applies to generated starters; optional
capabilities keep their own API minimums. Both init and later-add validate package
prerequisites before writing capability files or recording ownership. Persistence requires `@freeappstore/sdk >=0.16.18`
in the root `package.json`, because its generated module lives at the root.
PWA requires SDK `>=0.16.15` and `vite-plugin-pwa ^1.0.0` in
`web/package.json` when present, otherwise the root package. Development
dependencies are accepted for bundled browser apps. Capability-ID dependencies
and these package requirements are separate registry fields.

The entire declared semver range must satisfy the prerequisite: `^0.16.14`
does not establish persistence compatibility, even if a lockfile currently picks
a newer release. Workspace, file, link, git and tag references cannot establish
published package compatibility and are rejected with guidance. Keep those
choices and integrate manually if appropriate, or explicitly choose and install
a compatible published range. The CLI never changes package choices or lockfiles,
runs installation scripts, or reads app data. A dry-run prints prerequisites;
unmet requirements produce an `INCOMPLETE` plan with no writes. Apply rejects
before any capability writes. Correct prerequisites and rerun the preview.

Installing files still requires the printed manual integration steps: import the
persistence helper from app code; for PWA wrap the existing VitePWA options,
import the browser module, and register busy guards. The ownership manifest
records generated files, not completion of those steps. Fresh init uses the same
package preflight and no longer silently rewrites SDK dependencies.

Release validation for #353 must include the published-package fixture added in
#356: set `FAS_TEST_PUBLISHED=1` and run
`pnpm test packages/cli/src/lib/capability-packages.integration.test.ts`.
This checks generated persistence/PWA imports with TypeScript and a Vite PWA build.
The fixture is opt-in because it installs published packages over the network.
This is a narrow prerequisite for the canonical-foundation work in #352.

`fas init myapp --preset connectivity` or `fas init myapp --capabilities connectivity`
uses the same dependency resolver and install plan as `fas add connectivity` in an
existing app root (a directory with `package.json`). The default `minimal` preset
is an empty capability list; `connectivity` is the list `[connectivity]`. These
lists are independent of the existing `--template` choices.

Run `fas add connectivity --dry-run` to inspect file additions and manifest changes
without writing. The bundled browser capability creates
`fas-capabilities/connectivity.ts`; import `watchConnectivity` from that module in
your app to subscribe to online/offline hints, and call its returned cleanup
function on unmount. It does not promise server reachability or offline storage.

`fas add persistence` (or `--preset persistence` / `--capabilities persistence` at init)
installs the same way, now or later. It adds `fas-capabilities/persistence.ts`, a
device-only import of `@freeappstore/sdk/persist`. It does not delete preference
keys, IndexedDB databases, or edited files. An edited generated file is a conflict
until you resolve it yourself. Saved data is not account-backed `fas.kv`.

`fas add backup` (or `--preset backup`) installs `fas-capabilities/backup.ts` and,
if needed, the persistence capability it depends on. It requires
`@freeappstore/sdk >=0.16.21`; the recipe imports `@freeappstore/sdk/backup`.
Installation and a later removal of those generated files do not delete saved
data. Import still requires the app to choose merge or replace. An edited
generated file is a conflict.

The registry declares exact dependency versions, browser environment, owned files,
config changes (none for connectivity), and generated-content validation. It runs
no downloaded scripts and installs no npm dependencies.

Install `realtime` or `media` only when needed. `fas add realtime` provides a
cleanup-bound `fas.rooms` adapter for ephemeral broadcast; it is not private or
file transport. `fas add media` provides user-triggered capture, runtime format
selection, track cleanup and share/download export helpers. Review the generated
`fas-capabilities/realtime.md` and `fas-capabilities/media.md` before integrating.
Both require `@freeappstore/sdk >=0.16.26`; media helpers are shared from the
optional `@freeappstore/sdk/media` entry point and are absent from the root bundle.
The media APIs depend on secure-context browser support and user permission;
display capture is unavailable in some mobile browsers. Neither capability
requests permission at installation or provisions external services.

Commit `.fas-capabilities.json` with your app. Schema version 1 records each
capability's version and SHA-256 hashes of its owned files. Repeated installation
is a no-op. Existing apps need no migration: missing generated files are added;
identical files can be adopted; different unowned files and edited owned files
produce conflicts before any writes. Unrelated files are untouched. Generated
modules are optional imports, so installation does not rewrite application code.

For a future bundled version, first inspect `fas add connectivity --update
--dry-run`, then run with `--update`. Only files matching their recorded hashes
or the exact target bytes are accepted. Resolve edits manually; there is no force
overwrite. Removed generated files remain tracked and on disk. No migration hooks,
automatic deletion, or application/user-data migrations are supported. A failed
write may leave some generated files in place; rerun the same command to complete
installation. Exact generated bytes are safe to adopt on retry; differing bytes
remain conflicts. Run one installer at a time and use version control to review
and revert changes.
