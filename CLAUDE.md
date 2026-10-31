# FreeAppStore platform

## Delivery mode

**Straight to `main`. No branches, no pull requests.** Declared 2026-08-16.

**No branches. No pull requests. Ever.**
Commit directly to `main`. Do not run `git checkout -b`, `git switch -c`, or `gh pr create`. If you
find yourself on a non-`main` branch, stop and report it. (Declared 2026-08-16.)

## Styling

All UI, including the SDK, is React + Tailwind 4 on tokens ([ADR-001](docs/adr/001-tailwind-on-fas-tokens.md)). No inline styles except truly dynamic values, or injected CSS strings. Don't invent a different convention.
