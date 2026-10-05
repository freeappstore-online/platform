# FreeAppStore Storefront

Static HTML storefront for [freeappstore.online](https://freeappstore.online). Built with `node build.js` from `registry.json` — no framework, no npm dependencies.

## Build

```bash
node build.js    # generates dist/ from registry.json + page templates
npm test        # build + security regression tests
```

## Optional Git hooks

Install local convenience checks explicitly:

```bash
bash scripts/install-hooks.sh
```

This sets this checkout's local `core.hooksPath` to `.githooks`, replacing any
previous local setting. Hooks are never installed automatically on clone.
Pre-commit runs `npm run lint` (the existing design-system guard), and pre-push
runs `npm run test:security` (the existing security regression tests, also included
in `npm test`). The repo has no
configured typecheck command. Node.js 22, npm, and Bash are required; no npm
dependencies need installing. Run `npm test` for the full build and security
suite; build tests make network calls and take longer than the local hook.

Hooks check the working tree, including unstaged changes. They are convenience
tools only: CI independently runs the same design-system lint and test suite
on pull requests and pushes to `main`; deployment also runs the tests before
building. Skipping local hooks does not skip CI.

To uninstall, run `git config --local --unset core.hooksPath`. If you previously
used another hooks path, restore that setting instead.

## Deploy

Hosted on Cloudflare Pages. Push to `main` auto-deploys via GitHub Actions.

## Pages

| Page | File | Description |
|------|------|-------------|
| Home | `index.html` (generated) | App grid with category filters |
| App detail | `dist/<id>/index.html` | Per-app detail page |
| Developer | `developers.html` | Developer profile pages |
| About | `about.html` | Platform info |
| Contribute | `contribute.html` | How to publish |
| Build with AI | `build-with-ai.html` | VibeCode guide |
| Capabilities | `capabilities.html` | SDK features overview |
| Pricing | `pricing.html` | Free vs Pro comparison |
| Skills | `skills.md` | AI agent guide |

## Key files

- `build.js` — Static site generator (reads `registry.json`, emits HTML)
- `registry.json` — Source of truth for all published apps
- `SECURITY.md` — CSP, headers, threat model
- `_headers` — Cloudflare Pages headers (CSP, HSTS, etc.)
