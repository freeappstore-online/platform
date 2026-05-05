# @freeappstore/cli

## 0.1.2

- New: `fas doctor` — local health checks (Node version, git/pnpm installed, config readable, signed in, API reachable). One-shot prints results with ✓/!/✗; same data drives the Doctor screen in TUI mode.
- New: `fas` (no args) launches an interactive TUI built on `ink`. Scriptable subcommands keep working unchanged. When stdout isn't a TTY (CI, pipes), help is printed instead.

## 0.1.1

- Fix: `fas --version` reads from package.json at runtime instead of a hardcoded `0.0.0`. The published 0.1.0 reported the wrong version.

## 0.1.0

- Initial release. Commands: `login`, `logout`, `whoami`, `init`, `publish`, `logs`. Auto-publish via `fas publish` calls `/v1/publish` on the platform API; falls back to a prefilled GitHub Issue form when the auto-provision path is unavailable.
