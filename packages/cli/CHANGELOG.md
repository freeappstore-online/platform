# @freeappstore/cli

## 0.4.25

- **Fix (DX):** Clearer auth messaging on `fas publish`. An expired session used to surface as `401 Unauthorized` → "Not signed in", which reads as a _permissions_ problem and sent creators chasing access grants that don't exist (real support thread: a creator asked to be "granted publishing permission" when their token had simply expired). Now the CLI:
  - Distinguishes **never signed in** from **session expired** and says so explicitly, always noting that *any signed-in account can publish — there is no separate permission to request*.
  - Detects an expired (or soon-to-expire, ≤3 days) session **before** prompting, via a client-side check against the 30-day TTL.
  - `fas whoami` now reports session status (`active, expires in N days` / `expired`).
  - `fas login` confirms the 30-day lifetime and that you're ready to publish.
  - Provisioning failures that fall back to the Issue form now print a concise, human-readable reason instead of a raw JSON blob, and reassure the creator the fallback is normal.

## 0.4.5

- **Fix:** `fas login` now includes the resolved exchange URL in the error message when the auth-exchange step fails. A common support pattern is creators with a stale `apiBase` in `~/.fas/config.json` or a leftover `FAS_API_BASE` env var pointing at a host that returns a 404 — the previous error was hard to attribute. Now: `Auth exchange failed (404 from https://wrong-host/v1/auth/exchange): ...` with a one-line hint about where to fix it.

## 0.1.4

- New: `fas check` — runs the 5 [@freeappstore/compliance](https://www.npmjs.com/package/@freeappstore/compliance) checks against the current directory and prints results with actionable suggestions on each fail. Same checks the template's CI runs, so creators get instant local feedback instead of waiting for a push.

## 0.1.3

- **Fix:** TUI App stuck on `Loading…` if `~/.fas/config.json` was unreadable. Now degrades to "not signed in".
- **Fix:** Doctor screen no longer warns/leaks if user navigates away (Esc/b) before checks finish — tracks mount state.
- **Fix:** Removed global `q`-to-quit handler at App level; moved to Menu screen so future text inputs (NewApp wizard) can receive `q` as input.
- **Fix:** `apiBase` config values with trailing slashes no longer produce `//`-style URLs. Normalised on read.

## 0.1.2

- New: `fas doctor` — local health checks (Node version, git/pnpm installed, config readable, signed in, API reachable). One-shot prints results with ✓/!/✗; same data drives the Doctor screen in TUI mode.
- New: `fas` (no args) launches an interactive TUI built on `ink`. Scriptable subcommands keep working unchanged. When stdout isn't a TTY (CI, pipes), help is printed instead.

## 0.1.1

- Fix: `fas --version` reads from package.json at runtime instead of a hardcoded `0.0.0`. The published 0.1.0 reported the wrong version.

## 0.1.0

- Initial release. Commands: `login`, `logout`, `whoami`, `init`, `publish`, `logs`. Auto-publish via `fas publish` calls `/v1/publish` on the platform API; falls back to a prefilled GitHub Issue form when the auto-provision path is unavailable.
