# FreeAppStore AI Skills

Point your Claude Code or Codex to this file for platform-aware development.

**Add to your CLAUDE.md or agent config:**
```
See https://freeappstore.online/skills.md for platform skills.
```

---

## Platform Context

You are building an app for FreeAppStore (freeappstore.online). Follow these rules exactly.

### Platform Rules
- ONE environment: production only. Push to `main` = deploy. No staging, no rollbacks. Fix forward.
- Static hosting on Cloudflare Pages. No server-side code.
- Backend (if needed): `@freeappstore/sdk` (auth, KV, rooms, proxy).
- Free means free forever. No monetization in the free version.
- One app per category. Check freeappstore.online for taken categories.

### Tech Stack (required)
- TypeScript ^5.7
- React ^19.0
- Vite ^6.0
- Tailwind CSS ^4.1
- pnpm (workspace with web/ package)
- Node >=22

### Project Structure
```
app-name/
├── package.json           (root workspace)
├── pnpm-workspace.yaml    (packages: [web])
├── LICENSE                (MIT)
├── .github/workflows/compliance.yml
└── web/
    ├── package.json
    ├── index.html
    ├── vite.config.ts
    ├── tsconfig.json
    ├── public/manifest.json
    └── src/
        ├── main.tsx
        ├── index.css      (Tailwind + brand CSS variables)
        ├── App.tsx
        └── components/
```

### Brand Design (mandatory)
- Fonts: Manrope (body, all weights) + Fraunces (display, 700-800)
- CSS Variables: `--paper`, `--ink`, `--muted`, `--line`, `--panel`, `--glass`, `--dock`, `--accent`, `--success`, `--warning`, `--error`
- Layout: Desktop = sidebar (17rem) + main content. Mobile = header + main + bottom dock.
- Dark mode: via `prefers-color-scheme: dark` or `[data-theme='dark']`
- Border radius: 1.25rem (cards), 0.75rem (buttons)
- Transitions: 160ms ease (buttons), 200ms ease (cards)
- Must include "Part of FreeAppStore — free forever" link somewhere in the app

### Privacy Rules
- ZERO analytics, tracking, cookies
- No Google Analytics, Amplitude, Mixpanel, Segment, Hotjar, PostHog, Sentry
- All user data in localStorage (standalone) or `@freeappstore/sdk` KV (connected)
- No third-party scripts except Google Fonts CDN

### App Types

**Standalone** (no backend):
- All data in localStorage
- No account required
- Works fully offline
- Template: github.com/freeappstore-online/template-standalone

**Connected** (platform SDK):
- `@freeappstore/sdk` for auth, KV storage, realtime rooms, API proxy
- Free version must work for browsing without sign-in
- Start from template-standalone, add `npm i @freeappstore/sdk`

### Compliance Checks (automated on every push to main)
1. Build passes (`pnpm build`)
2. MIT LICENSE file exists
3. No .env.production in repo (env vars are in CF Pages settings)
4. No tracking dependencies or code
5. Manrope + Fraunces fonts in CSS
6. CSS variables (--paper, --ink, --accent) present
7. HTML meta tags (lang, viewport, title)
8. PWA manifest.json (name, display, start_url)
9. PWA meta tags (apple-mobile-web-app-capable)
10. "freeappstore.online" link in source
11. Dark mode support (prefers-color-scheme, data-theme, or color-scheme)
12. pnpm workspace structure
13. Bundle < 300KB gzipped

### Local Compliance Check
Run before pushing to catch issues early:
```bash
fas check
```

### Commands for Development
```bash
pnpm dev          # Start dev server
pnpm build        # Production build
pnpm preview      # Preview production build
```

### Publishing Workflow
1. Use template: `gh repo create freeappstore-online/appname --template freeappstore-online/template-standalone --public`
2. Replace APPNAME placeholder throughout
3. Build your app
4. Run compliance check locally
5. Submit at github.com/freeappstore-online/submissions
6. Review (48h response)
7. Approved → published at appname.freeappstore.online

### Environment Variables
- Deployment env vars go in CF Pages project settings — NEVER in the repo
- Developers use `.env` locally (gitignored) for their own dev project
- `.env.production` must NOT exist in the repo

### Do NOT
- Add dev/staging environments
- Add rollback mechanisms
- Add analytics or tracking
- Add monetization to free version
- Use npm or yarn (pnpm only)
- Use Next.js, Nuxt, or any SSR framework
- Create server-side APIs (use `@freeappstore/sdk` for backend features)
- Commit .env.production files (env vars are centralized in CF Pages)
