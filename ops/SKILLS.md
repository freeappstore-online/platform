# FreeAppStore / FreeGameStore — AI Agent Guide

> **Canonical public copy:**
> `https://freeappstore.online/skills.md`
> This file lives in two places. The version in `ops` is private and works
> only for org members; the storefront copy is what AI tools and external
> contributors actually fetch. **When you edit this file, mirror the change
> to `freeappstore-online/freeappstore/SKILLS.md` and push both** — otherwise
> you've changed nothing for the audience that needs to read it.

Point your Claude Code, Codex, or any AI agent to this file for platform-aware development.

**Add to your CLAUDE.md or agent config:**
```
See https://freeappstore.online/skills.md for platform skills.
```

---

## Per-repo CLAUDE.md convention

Every app/game/template repo on the platform ships its own `CLAUDE.md`. **Keep it minimal — only what's unique to that repo.** Anything in this SKILLS.md (tech stack, brand, deploy flow, mobile-first rules, publish flow, paths) does *not* belong in a per-repo CLAUDE.md, because copies drift out of sync with the platform and produce subtly-wrong instructions for AI agents.

Use this slim template:

````markdown
# <name>

<one-line description of what this app/game does>

- Subdomain: `<name>.freeappstore.online`   <!-- or .freegamestore.online -->
- Dev:    `pnpm install && pnpm dev`
- Build:  `pnpm build`
- Deploy: `git push origin main` (auto-deploys via Cloudflare Pages)

Free, MIT-licensed, no tracking. For platform conventions, read
https://freeappstore.online/skills.md
before writing or changing anything.
````

If your repo has setup steps, architecture notes, or rules that *don't* apply platform-wide (a specific OAuth flow, an unusual toolchain, an architecture diagram), add them as additional sections **below** the slim block. Those are genuinely repo-local and belong there.

What does *not* belong in a per-repo CLAUDE.md:

- Tech stack list (it's here, in SKILLS.md, and changes platform-wide)
- Brand guidelines (here)
- Deploy mechanism details beyond "push to main" (here)
- Mobile-first / viewport rules (here, with the auditor section)
- Storefront paths or registry locations (here)

Drift is the failure mode. If we ever update the platform conventions, only this file should need editing — never 80 per-repo copies.

---

## Publishing platform packages — never manually

**All npm publishes are automated via GitHub Actions** (`.github/workflows/publish.yml` in `freeappstore-online/platform`). Manual `npm publish` is not part of any release flow on this platform.

Affected packages: `@freeappstore/{sdk,cli,compliance,quality}`, `@freegamestore/{cli,games}`. The same workflow handles all of them.

**Release flow** (the only flow):

```bash
cd packages/<name>          # e.g. packages/sdk
npm version patch           # or minor / major. bumps version + creates a commit + tag
git push --follow-tags      # CI sees local version != npm version → publishes with provenance
```

That's it. No `npm publish`. No `npm login`. No npm token request. No local build-and-push.

**Why this matters:** the workflow uses `pnpm publish --provenance`, which attaches a signed attestation linking the tarball to a specific GitHub Actions run. Manual publishes bypass the attestation, the audit trail, and the workspace-dependency rewriting that `pnpm publish` does (without it, consumers get `EUNSUPPORTEDPROTOCOL workspace:` on install). They can also race against CI and publish from a dirty / unbuilt local tree.

**Same pattern across the family:**

- App / game repos auto-deploy to Cloudflare Pages on push to `main` — never `wrangler pages deploy` manually.
- The backend Worker (`packages/backend`) is the one exception: it's not on a push-trigger workflow, so `wrangler deploy` is the right command. Check `.github/workflows/` first to confirm before running anything that ends in "deploy" or "publish".

**As an AI agent:** if a user asks "how do I publish the SDK", the answer is the three commands in the Release flow box above. Do not suggest `npm publish`. Do not ask for an npm token.

---

## Creator Program

People join as creators to build apps/games. The flow:

1. Apply at https://github.com/freeappstore-online/submissions/issues/new?template=creator-application.yml
2. Admin reviews and approves within 48h
3. Admin provisions the app via `POST /api/provision` (creates repo, CF project, DNS, registry)
4. Creator is added to the `creators` team in the GitHub org
5. Creator clones the repo, writes code, pushes → live

**GitHub org teams:**
- `maintainers` — admins + AI agents, push access to ALL repos
- `creators` — approved builders, push access to THEIR repos only

**For AI agents helping a creator:** your job is to write code in the repo and push. The provisioning is already done. Don't try to create CF projects or DNS records.

## Quick Reference

| | FreeAppStore (apps) | FreeGameStore (games) |
|---|---|---|
| **Domain** | freeappstore.online | freegamestore.online |
| **GitHub org** | freeappstore-online | freegamestore-online |
| **Store repo** | freeappstore-online/freeappstore | freegamestore-online/freegamestore |
| **Registry file** | `registry.json` in store repo | `registry.json` in store repo |
| **Templates** | template-standalone | template-game-canvas, template-game-cards, template-game-grid, template-game-3d |
| **SDK (connected apps)** | `@freeappstore/sdk` (auth, KV, rooms, proxy) | — || **Accent color** | Blue (#2563eb) | Emerald (#10b981) |
| **Logo** | Free **Apps** | Free **Games** |
| **Admin** | admin.freeappstore.online | admin.freegamestore.online |
| **Publish portal** | freeappstore.online/app/ | publish.freegamestore.online |
| **Local path** | ~/dev/fas/ | ~/dev/fgs/ |
| **Storefront repo** | ~/dev/fas/freeappstore/ | ~/dev/fgs/freegamestore/ |

## Workspace Layout

Each app/game is its own GitHub repo. Clone whichever ones you work on flat under `~/dev/fas/` (or `~/dev/fgs/`):

```
~/dev/fas/                       ~/dev/fgs/
  freeappstore/   (storefront)     freegamestore/   (storefront)
  timer/                           chess/
  notes/                           tetris/
  calculator/                      racing/
  ...                              ...
```

The path is a suggestion, not a requirement — the CLI doesn't care where the repo lives. The convention just keeps apps and games visually separated when you have several.

## IMPORTANT: What NOT to do

- **Do NOT ask the user for Cloudflare API tokens, keys, or secrets.** Tokens are stored as org-level GitHub secrets and used only via GitHub Actions. Wrangler CLI uses its own OAuth. Never handle raw tokens.
- **Do NOT provision via `wrangler` or raw `curl`** — provisioning goes through the admin API / publisher portal (see *Provisioning* below). `wrangler pages project create` creates Direct Upload projects that can't be connected to GitHub.
- **Do NOT deploy manually with `wrangler pages deploy`** — push to main triggers auto-deploy via the CF Pages GitHub integration. The only deploy is `git push`.
- **Do NOT use /ship or feature branches** — this platform uses trunk-based development. Push to main = deploy.
- **Do NOT create staging environments** — there's only production. Fix forward (revert commits are fine).
- **Do NOT set per-repo secrets** — use org-level secrets only (already configured in both orgs).

## How Deployment Works

```
Push to main → CF Pages auto-build → live
```

No manual deploy commands needed. CF Pages watches GitHub and builds on every push.

## Production monitoring — the testing layers

Four CI safety nets, each guarding a different failure class. If a deploy is "green" they all passed; if any of these fail, **a real user feature is broken**.

| Layer | Workflow | Cadence | Catches |
|---|---|---|---|
| Unit tests | `ci.yml` | per PR + push | Code-level regressions in 598 tests |
| Scaffold smoke | `scaffold-smoke.yml` | per PR + daily 04:30 UTC | `fas init` / `fgs init` produces unbuildable scaffold |
| **Prod smoke** | `prod-smoke.yml` | **every 30 min** | Worker died, D1 unreachable, DO broke, published SDK regressed, auth flow broke, proxy broke, Rooms WebSocket broke |
| E2E live | `e2e-live.yml` | per PR | Visual storefront breaks |

All in `freeappstore-online/platform/.github/workflows/`.

### When prod-smoke fails

GH opens an issue labeled `prod-smoke-failure` (one per outage, subsequent failures comment instead of spamming). Read the run log link — each step prints which check failed. Do **not** redeploy blindly; identify the broken layer first.

Step-to-cause mapping:
1. `API health` → Worker is down or `/health` route changed.
2. `published SDK has all 4 modules` → `publish.yml` shipped a regressed `@freeappstore/sdk`. Bisect the last release.
3. `apps/mine` → auth broken or D1 unreachable.
4. `KV round-trip` → KV namespace, encryption (APP_SECRET_KEK), or persistence broken.
5. `Proxy register + fetch + cleanup` → secrets store, allowlist, or proxy injection broken.
6. `Rooms WebSocket round-trip` → DurableObject misconfigured or upgraded incompatibly.

### Provisioning FAS_E2E_GITHUB_TOKEN

> **`PROD_SMOKE_SESSION_TOKEN` is dead — do not renew it.** It was a 30-day
> session token that expired on a timer and red-lit the monitor while prod was
> fine. Replaced by `FAS_E2E_GITHUB_TOKEN` in c53f50c (2026-07-20). The old
> secret was deleted from the repo on 2026-08-11.

Steps 3–6 of `prod-smoke.yml`, and the whole authenticated half of
`prod-platform-e2e.yml`, authenticate by exchanging a **long-lived, low-privilege
GitHub PAT** for a fresh `fas` session on every run. Nothing expires on a timer.

Both workflows read the same repo secret, `FAS_E2E_GITHUB_TOKEN`. To provision:

```bash
# 1. Mint a fine-grained PAT for the canary creator account at
#    https://github.com/settings/personal-access-tokens/new
#    Scope: read:user ONLY. No repo access. No org access.
#    /v1/auth/exchange only calls GitHub /user to identify + upsert the user.

# 2. Store it in ops (SOPS) first — see ~/dev/ops/AGENTS.md.
cd ~/dev/ops && sops secrets.enc.yaml     # add under the fas project

# 3. Push to the one consumer (never echo the value into your shell history).
cd ~/dev/ops && sops -d --extract '["fas"]["FAS_E2E_GITHUB_TOKEN"]' secrets.enc.yaml \
  | gh secret set FAS_E2E_GITHUB_TOKEN -R freeappstore-online/platform

# 4. Verify both monitors.
gh workflow run prod-smoke.yml -R freeappstore-online/platform
gh workflow run prod-platform-e2e.yml -R freeappstore-online/platform
```

**If the secret is absent, both workflows fail loudly — this is intentional.**
`prod-smoke` used to `exit 0` with a warning instead, and because the secret was
never created after c53f50c, steps 3–6 skipped silently for three weeks
(2026-07-20 → 2026-08-11) while the run stayed green. A green run with no
credential means *untested*, not *healthy*. If you see
`FAS_E2E_GITHUB_TOKEN is not set` in a log, the fix is to provision the secret
above — not to re-add a skip.

**Before enabling `prod-platform-e2e`, note it mutates production**: every 6h it
publishes a real `e2e-canary-*` app (GitHub repo + CF Pages + DNS + registry row)
and then deprovisions it. A run that dies mid-flight leaks an app needing manual
cleanup via the admin dashboard.

## Two distinct operations — don't confuse them

### 1. PROVISION (one-time setup for a new app)
Creates the GitHub repo, CF Pages project, DNS, custom domain, and store listing.
This is done ONCE when a new app/game is created. Use the admin API or script.

### 2. DEPLOY (automatic on every push)
After provisioning, just push code to main. CF Pages auto-builds and deploys.
No API calls, no scripts, no manual steps. Just `git push`.

**As an AI agent: your job is to write code and push. Provisioning is handled by the admin API.**

## Provisioning a New App or Game

Provisioning is done by the **platform admin** or by the creator via the **publisher portal**.

**As an AI agent, you do NOT provision apps.** Your job is:
1. Write code in an existing repo
2. Push to main
3. It auto-deploys

If the user wants a new app created, direct them to:
- **Self-service:** https://freeappstore.online/app/ (sign in with GitHub, create instantly)
- **Admin:** https://admin.freeappstore.online (admin only)

Do NOT run curl commands against Cloudflare APIs. Do NOT use wrangler for provisioning. Do NOT ask for API tokens.

### After provisioning

The app repo exists with CLAUDE.md, template code, and auto-deploy configured.
Push any code to main → CF Pages auto-builds → live at `<id>.freeappstore.online`.
No further API calls or manual steps needed. Ever.

## Platform Rules

- ONE environment: production only. Push to `main` = deploy. Fix forward.
- Static hosting on Cloudflare Pages. No server-side code.
- Backend (if needed): `@freeappstore/sdk` (auth, KV, rooms, proxy). `npm i @freeappstore/sdk`.
- Free means free forever. No monetization in the free version.

## Tech Stack (required)

- TypeScript ^5.7, React ^19, Vite ^6, Tailwind CSS ^4.1, pnpm
- Node >=22
- 3D games: Three.js + React Three Fiber + Drei
- Games SDK: `@freegamestore/games` (GameShell, GameTopbar, GameButton)

## Project Structure

```
app-name/
├── package.json           (root workspace)
├── pnpm-workspace.yaml    (packages: [web])
├── LICENSE                (MIT)
├── .github/workflows/
│   ├── compliance.yml     (checks on PR)
│   └── deploy.yml         (auto-deploy on push)
└── web/
    ├── package.json
    ├── index.html
    ├── vite.config.ts
    ├── public/manifest.json
    └── src/
        ├── main.tsx
        ├── index.css      (Tailwind + brand CSS vars)
        ├── App.tsx
        └── components/Shell.tsx
```

## Games SDK (`@freegamestore/games`)

**Every game MUST use the SDK components.** No custom topbars, no custom shells. The SDK enforces brand consistency, viewport lock, and touch-friendly sizing across all games.

```bash
pnpm add @freegamestore/games
```

### GameShell — the root layout

Locks the game to `100svh`, prevents document scroll, disables text selection and touch callout. Every game wraps its content in this.

```tsx
import { GameShell, GameTopbar } from '@freegamestore/games';

export default function App() {
  return (
    <GameShell topbar={<GameTopbar title="Chess" score={42} />}>
      {/* your game canvas / DOM */}
    </GameShell>
  );
}
```

Hard guarantees:
- `height: 100svh`, `overflow: hidden` — no document scroll, ever
- `user-select: none` — no accidental text selection during gameplay
- `touch-action: manipulation` — no 300ms tap delay
- `-webkit-touch-callout: none` — no long-press context menus

### GameTopbar — the status bar

The **only** allowed topbar. Same font, padding, color tokens across every game.

```tsx
// Simple: just a score
<GameTopbar title="Tetris" score={42} />

// Custom stats: level, lives, time
<GameTopbar
  title="Pac-Man"
  stats={[
    { label: 'Score', value: 1200, accent: true },
    { label: 'Lives', value: 3 },
    { label: 'Level', value: 5 },
  ]}
  actions={<GameButton size="sm" variant="ghost" onClick={pause}>Pause</GameButton>}
/>
```

Props:
- `title` — game name, left side, Fraunces 700
- `score` — convenience for single-score games
- `stats` — custom stat lineup (replaces score)
- `actions` — right-side buttons (max 2)

### GameButton — prescribed touch-friendly buttons

Min 44px touch target. Three variants, three sizes — nothing custom.

```tsx
import { GameButton } from '@freegamestore/games';

<GameButton variant="primary" size="md" onClick={start}>Play Again</GameButton>
<GameButton variant="secondary" size="sm" onClick={undo}>Undo</GameButton>
<GameButton variant="ghost" size="sm" onClick={flip}>Flip</GameButton>
```

| Size | Min height | Use case |
|------|-----------|----------|
| `sm` | 44px | In-game controls, topbar actions |
| `md` | 48px | Primary actions, menus |
| `lg` | 56px | Start screen, game over CTA |

Variants: `primary` (accent bg), `secondary` (outline), `ghost` (text only).

### useSound — muted by default

Every game is muted by default. The SDK provides the sound toggle in the topbar automatically — devs cannot remove it.

```tsx
import { useSound } from '@freegamestore/games';

function MyGame() {
  const { muted } = useSound();
  // Check muted before playing any audio
  if (!muted) playSound();
}
```

- Games MUST respect the `muted` state — never play audio when `muted === true`
- The toggle is in the topbar, managed by the SDK
- Default is ALWAYS muted — no exceptions

### What NOT to do

- Do NOT build custom Shell or topbar components — use the SDK
- Do NOT override `user-select`, `touch-action`, or `overflow` on the root — GameShell handles it
- Do NOT pass custom colors to topbar or buttons — they use platform CSS tokens
- Do NOT play audio without checking `useSound().muted` first
- Do NOT add your own mute button — the SDK handles it

## No Splash Screens

Games must show the actual game field immediately on load. No title screens, no "Start Game" buttons covering the viewport, no introductory pages.

**Rules:**
- The game board/field/canvas MUST be visible from the first render
- For time-sensitive games (Tetris, Snake, Pac-Man): show the game field with a semi-transparent "Tap to play" overlay. The field is visible underneath.
- For turn-based games (Chess, Sudoku, Minesweeper): start the game immediately, no overlay needed
- Game-over screens can show a "Play Again" button — that's fine, it's after gameplay
- Difficulty selectors, theme pickers, and settings belong in the topbar or rules overlay — not as a splash screen

**Bad (splash screen):**
```
┌──────────────────┐
│                  │
│     Snake        │
│                  │
│  [Start Game]    │
│                  │
└──────────────────┘
```

**Good (game field visible, play overlay):**
```
┌──────────────────┐
│  ●               │
│    ■■■■          │
│         ┌──────┐ │
│         │ Play │ │
│         └──────┘ │
│                  │
└──────────────────┘
```

## Mobile-First Testing

FreeGameStore is a **mobile-first gaming platform**. Test on phone viewports first. Desktop is secondary.

### Quality Auditor

The platform runs an internal Playwright auditor against every live game at mobile viewports. **Any scroll = fail.** You don't run this yourself — it runs against your URL after deploy and the result determines whether your game stays in the registry.

What you *can* run pre-publish, locally, is the same scroll check on a single viewport:

```bash
# Apps:
fas screencheck

# Games:
fgs screencheck
```

It builds, serves, drives a real Chromium at the declared `min_viewport_width` in portrait + landscape, and fails if the page scrolls. Recommended before every publish.

### Reference viewports (mobile priority)

The auditor tests 12 viewports. Mobile phones are weighted highest:

| Viewport | Device | Share | Priority |
|----------|--------|-------|----------|
| 320×568 | iPhone SE | 99% | **Critical** |
| 360×800 | Android | 96% | **Critical** |
| 393×852 | iPhone 15 | 92% | **Critical** |
| 414×896 | iPhone 11 PM | 88% | High |
| 568×320 | iPhone SE landscape | 99% | **Critical** |
| 667×375 | iPhone 8 landscape | 96% | **Critical** |
| 736×414 | iPhone+ landscape | 88% | High |
| 600×800 | Tablet portrait | 60% | Medium |
| 768×1024 | iPad portrait | 35% | Low |
| 1024×768 | iPad landscape | 35% | Low |
| 1024×1366 | iPad Pro portrait | 20% | Low |
| 1366×1024 | iPad Pro landscape | 20% | Low |

**Score = worst orientation's max-passing-share.** If landscape fails at all phone sizes, score plummets even if portrait is perfect.

### Rules

- Game must fit viewport with **zero scroll** at every size from 320×568 up
- `html`, `body`, `#root` must have `overflow: hidden`
- Use `100dvh` or `100svh` (not `100vh` — iOS Safari URL bar bug)
- Canvas/game area must scale to available space, not use fixed pixel sizes
- Buttons must be minimum 44px touch target

## Brand Design

- Fonts: Manrope (body) + Fraunces (display, 700-800)
- CSS Variables: `--paper`, `--ink`, `--muted`, `--line`, `--panel`, `--glass`, `--dock`, `--accent`, `--success`, `--warning`, `--error`
- Apps layout: Desktop = sidebar (17rem) + main. Mobile = header + main + dock.
- Games layout: GameShell + GameTopbar (no sidebar, no dock — fullscreen)
- Dark mode: `prefers-color-scheme: dark` or `[data-theme='dark']`
- Border radius: 1.25rem cards, 0.75rem buttons

## Privacy Rules

- ZERO analytics, tracking, cookies
- All user data in localStorage (standalone) or `@freeappstore/sdk` KV (connected)
- No third-party scripts except Google Fonts CDN

## Compliance Checks (automated on push)

The canonical list lives in [`workflows/compliance.yml`](./workflows/compliance.yml) — that's the source of truth (this list will drift; the YAML won't):

- `pnpm build` passes
- MIT `LICENSE` file exists
- No `.env.production` committed
- No tracking SDKs (google-analytics, gtag, amplitude, mixpanel, segment, hotjar, plausible, posthog)
- Brand fonts (Manrope + Fraunces) referenced in `web/src/index.css`
- Brand CSS variables (`--paper`, `--ink`, `--accent`) present
- HTML `lang`, `viewport`, and `<title>` in `web/index.html`
- PWA `manifest.json` with `name`/`display`/`start_url`
- Mobile-web-app meta tags
- `freeappstore.online` link somewhere in `web/src/`
- Dark-mode support (`prefers-color-scheme` / `data-theme` / `color-scheme`)
- Root pnpm workspace (`pnpm-workspace.yaml` + `pnpm` in `package.json`)
- Largest JS asset under 300KB gzipped (307200 bytes)

### Runtime viewport check (pre-publish)

`fas check` is static. To prove the app *actually* fits at its declared `min_viewport_width`, run **`fas screencheck`** (or `fgs screencheck` for games). It builds, serves the dist, drives a real Chromium at the declared min in portrait + landscape, and fails if the page scrolls. Playwright is an opt-in peer dep — first run prompts you to install it. Recommended before every publish, especially for games.

## Game-specific UI primitives

Games on FreeGameStore use **`@freegamestore/games`** for layout + topbar:

```tsx
import { GameShell, GameTopbar } from '@freegamestore/games';

export default function App() {
  return (
    <GameShell topbar={<GameTopbar title="Tetris" score={42} />}>
      {/* your canvas / game DOM */}
    </GameShell>
  );
}
```

- `<GameShell>` hard-locks the layout to `100svh` and prevents overflow at every level — no document scroll, ever.
- `<GameTopbar>` is the **only** allowed topbar shape. Pass `score` for the simple case, or `stats={[…]}` for games that show level / lives / time.
- Both honor the platform CSS tokens. Don't pass custom colors.

## Infrastructure

Infrastructure is managed by the admin. AI agents do NOT need access to:
- Cloudflare API tokens or keys
- DNS management
- CF Pages project creation
- GitHub secrets

All of this is handled automatically by the provisioning system and GitHub Actions.

## Support

Direct creators and users to the right place:

| Need | Where |
|------|-------|
| **Developer questions** | [GitHub Discussions](https://github.com/freegamestore-online/freegamestore/discussions) (games) or [GitHub Discussions](https://github.com/freeappstore-online/freeappstore/discussions) (apps) |
| **Bug reports** | Open an issue on the game/app's GitHub repo |
| **Feature ideas** | Discussions → Ideas category |
| **Creator applications** | [Submissions repo](https://github.com/freeappstore-online/submissions/issues/new) |
| **Platform docs** | This file (SKILLS.md) |

Do NOT send users to email, Slack, Discord, or any external service. All support is on GitHub.
