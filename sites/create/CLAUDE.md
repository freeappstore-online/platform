# VibeCode (RETIRED — folded into the console 2026-07-18)

> **This standalone app is no longer deployed to users.** The VibeCode builder was
> ported into the console at `freeappstore.online/app/build`
> (`sites/console/web/src/builder/`, a react-router island). `create.freeappstore.online`
> now **301-redirects** to `/app/build` (see `workers/host/src/index.ts` PLATFORM_SUBDOMAINS).
> This source + `deploy-create.yml` are kept for reference/history only; edit the copy
> under `sites/console/web/src/builder/` instead. Do not resurrect this subdomain.

## What this was
The VibeCode React app — AI-powered app builder for FreeAppStore.
Users describe an app, the agent builds it, deploys it, and they get a preview on `.pages.dev`.
Publishing to the store (DNS + custom domain + registry) is a separate step via the Publish page.

Was deployed at: `create.freeappstore.online` (now redirected).
Separate from the store site (freeappstore.online) which is static HTML.

## Tech Stack
- TypeScript, React 19, Vite 6, Tailwind CSS 4.1, pnpm
- React Router for client-side routing
- No backend — calls api.freeappstore.online and agent.freeappstore.online

## Pages

| Route | Page | Description |
|-------|------|-------------|
| `/` | Create | VibeCode chat + preview + deploy. Main AI builder. |
| `/profile` | Profile | User account, AI provider key management |
| `/publish` | Publish | Self-service publish to store (POSTs api.freeappstore.online/v1/publish with the platform session) |
| `/admin` | Admin | Monitoring dashboard (calls `api.freeappstore.online/v1/admin/*` with the platform session) |

## Structure
```
create/
├── web/
│   ├── src/
│   │   ├── App.tsx                 ← Router (4 routes)
│   │   ├── main.tsx
│   │   ├── index.css               ← Tailwind + brand CSS variables
│   │   ├── components/
│   │   │   ├── Nav.tsx             ← Header nav + mobile hamburger
│   │   │   ├── ChatMessage.tsx     ← Message bubble + markdown rendering
│   │   │   ├── Markdown.tsx        ← Lightweight markdown renderer (zero deps)
│   │   │   ├── DeployLog.tsx       ← Circular progress + deploy steps
│   │   │   ├── ProjectPicker.tsx   ← Project selector modal with search
│   │   │   └── AISettings.tsx      ← Per-provider API key management
│   │   ├── pages/
│   │   │   ├── Create.tsx          ← VibeCode chat + preview + deploy
│   │   │   ├── Profile.tsx         ← User profile + AI key management
│   │   │   ├── Publish.tsx         ← Self-service publish to store
│   │   │   └── Admin.tsx           ← Monitoring + unpublish
│   │   ├── hooks/
│   │   │   ├── useAuth.ts          ← Auth context (GitHub OAuth)
│   │   │   ├── useAgent.ts         ← SSE streaming, projects, chat state
│   │   │   └── useProjects.ts      ← Project CRUD in localStorage
│   │   └── lib/
│   │       ├── api.ts              ← API client (auth, agent URLs)
│   │       └── ai-keys.ts          ← Provider configs + localStorage key mgmt
│   ├── public/
│   │   ├── manifest.json
│   │   └── _redirects              ← SPA routing for CF Pages
│   └── package.json
├── package.json
└── CLAUDE.md
```

## Development
```bash
pnpm install
pnpm dev          # http://localhost:5173
pnpm build        # builds to web/dist
```

## Deployment
Hosted on Cloudflare Pages.
- Domain: create.freeappstore.online
- Build command: `npx pnpm@10 install && npx pnpm@10 build`
- Build output: `web/dist`
- Push to main = auto-deploy

## Auth
Uses the same `.freeappstore.online` cookie as the store site.
GitHub OAuth via api.freeappstore.online/auth/*.
useAuth hook checks /auth/me on load and provides user context.

## Agent
Calls agent.freeappstore.online/session/:id/* for chat.
useAgent hook handles: SSE streaming, tool call rendering,
project management (localStorage), deploy status tracking.

## External APIs called
- `api.freeappstore.online` — auth (sign in, sign out, user info, GitHub token)
- `agent.freeappstore.online` — AI chat sessions (SSE streaming)
- `api.freeappstore.online/v1/publish` — self-service publish (from /publish page; session-auth, proxies to the admin Worker). The legacy `publish.freeappstore.online` (freeappstore-publisher) was decommissioned 2026-06-30.
- `api.freeappstore.online/v1/admin/*` — monitoring and grants from `/admin`
- `admin.freeappstore.online` — privileged provisioning/deprovisioning worker, protected by Cloudflare Access
- `api.github.com` — org repos list (unauthenticated, for project picker)
