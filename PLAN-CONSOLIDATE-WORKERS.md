# Plan: Consolidate FAS Workers

Merge admin, agent, publisher into platform backend. Move create to R2. Fix host routing.

## Goal

Go from 9 services to 5:
- **Kill:** publisher (dead code, redirect to console)
- **Merge:** admin routes + agent routes + AgentSession DO into platform backend
- **Fix:** create deploy (add R2 workflow), host routing (add console + create to PLATFORM_SUBDOMAINS)

## What already exists

- Console already deploys to R2 via GitHub Actions
- Platform backend already has ADMIN service binding to admin Worker
- Publisher duplicates admin's provisioning logic (dead code)
- Host worker has PLATFORM_SUBDOMAINS map but is missing console + create

## Implementation steps

### Phase A: Static sites + routing (zero risk)

1. **create → R2**: Copy console's deploy.yml to create repo (same pattern: build → verify → S3 sync to `fas-apps/apps/create/`)
2. **Host routing**: Add `console` and `create` to PLATFORM_SUBDOMAINS map in host worker. Both serve from R2 at `apps/{name}/`
3. **Publisher → redirect**: Change host's `publisher` entry from proxy to 301 redirect to `console.freeappstore.online`

### Phase B: Admin merge

4. **Port admin routes** into platform backend as `packages/backend/src/routes/admin.ts`:
   - GET /api/status, /api/stats, /api/users, /api/creators
   - POST /api/provision (use admin's `handlePublish()` from publish.ts)
   - POST /api/unpublish, /api/deprovision
   - POST /api/fix-dns
   - GET/POST/PATCH/DELETE /api/apps/:proj/domains
   - GET/PUT /api/test-report
5. **Port CF Access JWT verification** as `packages/backend/src/lib/cf-access.ts`
6. **Add bindings** to platform wrangler.toml: CREATORS KV, CF_API_TOKEN, GITHUB_TOKEN, CF env vars
7. **Remove ADMIN service binding** from platform wrangler.toml (no longer needed, routes are local)
8. **Update host** routing: change `admin` from service binding to same Worker (or remove from PLATFORM_SUBDOMAINS since admin routes live at api.freeappstore.online now)

### Phase C: Agent merge

9. **Port agent route handlers** into platform backend as `packages/backend/src/routes/agent.ts`
10. **Port AgentSession DO** class into `packages/backend/src/do/agent-session.ts`
11. **Port agent tools/session logic** into `packages/backend/src/agent/` directory
12. **Add DO binding** to platform wrangler.toml: `AGENT_SESSION` class `AgentSession`, new SQLite migration tag
13. **Add ANTHROPIC_API_KEY** secret to platform Worker
14. **Update host** routing: change `agent` from pages.dev proxy to api.freeappstore.online routes

### Phase D: Cleanup

15. **Delete publisher Worker** from CF dashboard (after redirect is live)
16. **Delete admin Worker** from CF dashboard (after routes are merged and tested)
17. **Delete agent Worker** from CF dashboard (after DO is migrated and tested)
18. **Update docs**: PLATFORM-LAYOUT.md, stores/CLAUDE.md, SKILLS.md references to separate workers
19. **Archive repos**: Mark admin, agent, publisher repos as archived on GitHub

## NOT in scope

- MCP server stays separate (has its own DO, different deployment cadence)
- freeappstore store site stays on CF Pages (static HTML, different build)
- No new features added during migration
- No refactoring of admin/agent logic (port as-is, refactor later)

## Risks

- **Agent DO migration**: AgentSession data in old namespace is lost. Acceptable (ephemeral chat sessions).
- **CF Access JWT**: Currently verified by admin Worker. After merge, platform backend needs the same verification logic + CF Access public key caching.
- **Secret sprawl**: Platform wrangler.toml gains 5+ new secrets. All already exist, just need `wrangler secret put` on the platform Worker.

## Success criteria

- `api.freeappstore.online/api/status` returns app registry (was admin)
- `api.freeappstore.online/session/:id/chat` streams AI responses (was agent)
- `publish.freeappstore.online` redirects to console
- `console.freeappstore.online` serves from R2 (already works)
- `create.freeappstore.online` serves from R2 (new deploy.yml)
- All existing SDK endpoints unaffected
- 3 fewer Workers, 3 fewer repos to maintain

## Worktree parallelization

| Lane | Steps | Modules touched | Depends on |
|------|-------|----------------|------------|
| A | 1, 2, 3 | create repo, host worker | Independent |
| B | 4, 5, 6, 7, 8 | platform backend, host | Independent of A |
| C | 9, 10, 11, 12, 13, 14 | platform backend, host | After B (shared wrangler.toml) |
| D | 15, 16, 17, 18, 19 | CF dashboard, docs | After A + B + C verified |

Launch A + B in parallel. Then C. Then D.

## Implementation Tasks

- [ ] **T1 (P1, CC: ~5min)** -- create -- Add deploy.yml for R2 hosting
  - Surfaced by: Audit — create has no deploy workflow
  - Files: fas/create/.github/workflows/deploy.yml
  - Verify: push to main → create.freeappstore.online loads

- [ ] **T2 (P1, CC: ~5min)** -- host -- Add console + create to PLATFORM_SUBDOMAINS
  - Surfaced by: Audit — missing from host routing map
  - Files: fas/host/src/index.ts
  - Verify: curl console.freeappstore.online, curl create.freeappstore.online

- [ ] **T3 (P1, CC: ~2min)** -- host -- Change publisher to 301 redirect
  - Surfaced by: D3 — publisher is dead code
  - Files: fas/host/src/index.ts
  - Verify: curl -L publish.freeappstore.online → console.freeappstore.online

- [ ] **T4 (P1, CC: ~30min)** -- platform -- Port admin routes
  - Surfaced by: D4 — admin's provisioning code is proven
  - Files: packages/backend/src/routes/admin.ts, packages/backend/src/lib/cf-access.ts
  - Verify: curl api.freeappstore.online/api/status

- [ ] **T5 (P1, CC: ~10min)** -- platform -- Add admin bindings to wrangler.toml
  - Surfaced by: Architecture — admin needs KV, CF env vars, secrets
  - Files: packages/backend/wrangler.toml
  - Verify: wrangler deploy succeeds

- [ ] **T6 (P1, CC: ~45min)** -- platform -- Port agent routes + AgentSession DO
  - Surfaced by: D2 — agent DO moves into platform
  - Files: packages/backend/src/routes/agent.ts, packages/backend/src/do/agent-session.ts, packages/backend/src/agent/*
  - Verify: SSE chat stream works at api.freeappstore.online/session/:id/chat

- [ ] **T7 (P1, CC: ~5min)** -- platform -- Add AgentSession DO + ANTHROPIC_API_KEY
  - Surfaced by: Architecture — agent needs DO binding + API key
  - Files: packages/backend/wrangler.toml
  - Verify: wrangler deploy, DO instance spawns

- [ ] **T8 (P2, CC: ~10min)** -- host -- Update admin + agent routing
  - Surfaced by: Architecture — subdomains need to point to merged Worker
  - Files: fas/host/src/index.ts
  - Verify: admin.freeappstore.online routes to platform, agent.freeappstore.online routes to platform

- [ ] **T9 (P2, CC: ~15min)** -- cleanup -- Delete old Workers, archive repos, update docs
  - Surfaced by: Cleanup phase
  - Files: CF dashboard, GitHub settings, PLATFORM-LAYOUT.md, stores/CLAUDE.md
  - Verify: old workers.dev URLs return 404
