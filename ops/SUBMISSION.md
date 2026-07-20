# App Submission & Publishing Process

## Overview

Developers submit apps via GitHub Issues. We review, approve, and publish. The process is intentionally simple — no app binary uploads, no review queues, no waiting weeks.

## Submission Flow

```
Developer                    Platform (us)                    Live
────────                    ─────────────                    ────
1. Open Issue ──────────▶ 2. Review submission
   (GitHub template)         - Meets criteria?
                             - Category available?
                             - Code quality check
                                    │
                             3. Approve/Reject
                                    │
                        ┌───────────┴───────────┐
                        ▼                       ▼
                   4. APPROVED              REJECTED
                   - Transfer/fork repo     - Feedback given
                   - Create CF Pages        - Can resubmit
                   - Add DNS record
                   - Add to landing page
                        │
                        ▼
                   5. LIVE on
                   appname.freeappstore.online
```

## Step 1: Developer Submits

Developer opens an issue in `freeappstore-online/submissions` repo using the "App Submission" template.

### Required information:
- **App name** (single word, lowercase)
- **Category** (Learning, Strategy, Discovery, Brain Training, Social, Productivity, etc.)
- **One-line description**
- **Full description** (what it does, who it's for)
- **GitHub repo URL** (must be public, MIT licensed)
- **Demo URL** (if already deployed somewhere)
- **App type**: Standalone (no backend) or Connected (`@freeappstore/sdk`)
- **Checklist** (developer self-certifies):
  - [ ] Truly free forever — no monetization in free version
  - [ ] Responsive — works 320px to 2560px
  - [ ] Offline-capable (standalone) or graceful offline (connected)
  - [ ] PWA installable (manifest.json, service worker)
  - [ ] No tracking/analytics/cookies
  - [ ] Uses Manrope + Fraunces fonts
  - [ ] Follows FreeAppStore CSS variables
  - [ ] Sidebar desktop + dock mobile layout
  - [ ] Dark mode via prefers-color-scheme
  - [ ] MIT license
  - [ ] CLAUDE.md included for AI agents
  - [ ] TypeScript, React 19, Vite 6, Tailwind 4, pnpm

## Step 2: We Review

### Automated checks (CI on the repo):
- `pnpm build` passes
- `pnpm typecheck` passes
- No `any` types
- Largest JS asset < 300KB gzipped (per `workflows/compliance.yml` — 307200 bytes)

### Manual review:
1. **Category check** — is this category already taken? (One app per category rule)
2. **Quality check** — open the demo, test on mobile, test offline
3. **Brand compliance** — fonts, colors, layout match guidelines
4. **Privacy check** — no network requests to tracking services
5. **Code review** — no malicious code, no hidden dependencies

### Review timeline:
- First response within 48 hours
- Full review within 1 week
- If changes needed, developer gets specific feedback

## Step 3: Approve or Reject

### Approval:
- Comment "Approved" on the issue
- Label: `approved`
- Proceed to publishing

### Rejection reasons:
- Category already taken → suggest contributing to existing app
- Doesn't meet quality criteria → specific feedback on what to fix
- Not truly free → explain the free-forever requirement
- Too similar to existing app → suggest differentiation or collaboration

### Rejection is not permanent:
- Developer can fix issues and resubmit
- We provide constructive feedback
- We want apps to succeed

## Step 4: Publishing (Maintainer Workflow)

> **Historical reference only.** The current workflow is **freeappstore.online/app/** (creators) or the admin API (maintainers). The recipes below remain documented for emergency manual recovery only — e.g. portal outage. Do not run them as the normal path; see [`SKILLS.md`](./SKILLS.md).

Once approved, a maintainer runs these steps:

### 4a. Repo setup
```bash
# Option A: Developer transfers their repo to our org
gh api repos/DEVELOPER/APPNAME/transfer --method POST --field new_owner=freeappstore-online

# Option B: Developer's repo stays in their account, we fork
# (Less preferred — we want it in our org for consistency)
```

### 4b. Verify CLAUDE.md and CI
Ensure the repo has:
- `CLAUDE.md` with platform instructions
- `.github/workflows/ci.yml` (typecheck on PRs)
- Correct `packageManager` field in package.json

### 4c. Create Cloudflare Pages project
```bash
# Refresh token
wrangler whoami
CF_TOKEN=$(grep oauth_token ~/Library/Preferences/.wrangler/config/default.toml | cut -d'"' -f2)
ACCT="<CF_ACCOUNT_ID>"

curl -s -X POST "https://api.cloudflare.com/client/v4/accounts/$ACCT/pages/projects" \
  -H "Authorization: Bearer $CF_TOKEN" \
  -H "Content-Type: application/json" \
  --data '{
    "name": "freeAPPNAMEapp",
    "source": {
      "type": "github",
      "config": {
        "owner": "freeappstore-online",
        "repo_name": "APPNAME",
        "production_branch": "main",
        "deployments_enabled": true
      }
    },
    "build_config": {
      "build_command": "pnpm install && pnpm build",
      "destination_dir": "web/dist"
    },
    "deployment_configs": {
      "production": {
        "env_vars": {
          "NODE_VERSION": {"value": "22"}
        }
      }
    }
  }'
```

### 4d. Add custom domain
```bash
curl -s -X POST "https://api.cloudflare.com/client/v4/accounts/$ACCT/pages/projects/freeAPPNAMEapp/domains" \
  -H "Authorization: Bearer $CF_TOKEN" \
  -H "Content-Type: application/json" \
  --data '{"name":"APPNAME.freeappstore.online"}'
```

### 4e. Add DNS CNAME record
```bash
ZONE="<freeappstore-zone-id>"
EMAIL="<CF_ADMIN_EMAIL>"
KEY="<GLOBAL_API_KEY>"

curl -s -X POST "https://api.cloudflare.com/client/v4/zones/$ZONE/dns_records" \
  -H "X-Auth-Email: $EMAIL" \
  -H "X-Auth-Key: $KEY" \
  -H "Content-Type: application/json" \
  --data '{"type":"CNAME","name":"APPNAME","content":"freeAPPNAMEapp.pages.dev","proxied":true}'
```

### 4f. Add app detail page
Create `freeappstore/apps/APPNAME.html` following the existing template (copy chess.html and modify).

### 4g. Add to landing page
Add app card to `freeappstore/index.html` in the apps-grid.

### 4h. Update sitemap
Add URLs to `freeappstore/sitemap.xml`.

### 4i. Close the issue
Comment with the live URL, close the issue, label: `published`.

## Step 5: Post-Publishing

- App is live at `APPNAME.freeappstore.online`
- Developer has push access to their repo
- Pushes to main auto-deploy (no approval needed for updates)
- We only intervene if the app violates platform rules

## Ongoing Maintenance

### Developer responsibilities:
- Keep the app working
- Fix bugs (forward only, no rollbacks)
- Respond to user issues on GitHub
- Don't add tracking/analytics
- Don't add monetization to the free version

### Platform responsibilities:
- Keep CF Pages and DNS running
- Monitor for violations
- Update shared infrastructure if needed

### Removal criteria:
- App adds tracking/ads/monetization → warning, then removal
- App becomes unmaintained and broken for 90+ days → archived
- Developer requests removal → honored immediately
- Security vulnerability unfixed for 7+ days → taken down until fixed

## Connected Apps (with Pro Version)

For connected apps, additional steps:
1. Pro repo created in `proappstore-online` org
1. App uses `@freeappstore/sdk` for auth/KV/rooms (platform-managed backend)
2. App ID registered — KV and rooms are scoped to it