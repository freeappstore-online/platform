# VibeCode Agent — Tool Reference

## File tools (local, fast)

| Tool | Description | Auth |
|------|-------------|------|
| `write_file` | Create or overwrite a project file | None |
| `read_file` | Read a project file | None |
| `list_files` | List all project files | None |
| `delete_file` | Delete a project file | None |
| `search_files` | Grep across all project files | None |
| `run_compliance_check` | Validate project against platform rules | None |

## Infra tools (server-side, needs secrets)

| Tool | Description | Auth |
|------|-------------|------|
| `deploy` | Create GitHub repo + push code → GitHub Actions deploys to R2 (preview only — no DNS, no registry) | Session-scoped (sets appId) |
| `push_update` | Push code update to existing app | Session-scoped (must match appId) |
| `check_deploy_status` | Check GitHub Actions deploy status | Session-scoped |
| `get_build_logs` | Read GitHub Actions build logs | Session-scoped |
| `get_ci_results` | Read GitHub Actions check results | Session-scoped |
| `get_audit_results` | Read quality audit results | Any session |
| `list_deployed_apps` | List all apps in registry | Any session |
| `fetch_url` | Fetch a public HTTPS URL | SSRF-protected |

## Deploy vs Publish

The `deploy` tool creates a **preview** — not a published store listing:

| | Deploy (agent) | Publish (publisher portal) |
|---|---|---|
| GitHub repo | Creates in org | Already exists |
| R2 hosting route | Created (D1 routes table) | Created |
| DNS CNAME | No | Yes |
| Custom domain | No | Yes (`{id}.freeappstore.online`) |
| Registry entry | No | Yes |
| Store visibility | No — preview on `{id}.freeappstore.online` via host worker | Yes — listed on store |

## Compliance checks (run_compliance_check)

Validates 14 rules matching the CI compliance workflow:

1. MIT License file exists
2. No .env.production committed
3. No tracking SDKs (google-analytics, gtag, amplitude, etc.)
4. No payments (free tier): Payment Request API, Apple Pay, Google Pay, Stripe, PayPal, Paddle, Lemon Squeezy, Gumroad, payment manifest members
5. No ads: AdSense, Ad Manager, IMA, H5 Games Ads / AdMob, Amazon, Prebid, Carbon, Taboola, Outbrain, game-portal ad SDKs and others
6. Brand fonts referenced (Manrope + Fraunces)
7. CSS variables present (--paper, --ink, --accent)
8. HTML meta tags (lang, viewport, title)
9. PWA manifest (name, display, start_url)
10. PWA meta tags (apple-mobile-web-app-capable)
11. FreeAppStore link in source
12. Dark mode support (prefers-color-scheme)
13. pnpm workspace configured
14. No APPNAME placeholders remaining

Rules 4 and 5 aren't reimplemented here. `src/compliance.ts` imports
`checkNoPayments` and `checkNoAds` from `packages/compliance/src/checks/`, the
same code `fas check` and app CI run, so the patterns stay in one place. It
imports the check modules by relative path, as `src/push.ts` does with the
backend's web-push, because this Worker is its own pnpm workspace (it can't use
`workspace:*`) and the package entry pulls in `node:fs`, which a Worker without
`nodejs_compat` can't load. `src/shared-compliance.d.ts` declares the Node
modules the CLI-only `fsFileSource` imports, so `tsc` can check the shared
files. They are never bundled. A change under `packages/compliance/` redeploys
the agent (`deploy-agent.yml` paths).

The other rules are advisory: the model is told to fix failures before
deploying, and app CI gates them after the push. Payments and ads are a hard
gate. `deploy` and `push_update` run the two shared checks first, next to the
build sanity preflight. On a failure they push nothing, set the deploy status
to `error` ("Compliance check failed: No payments (free tier)"), and return a
`Deploy BLOCKED` result that names the files and the fix, so the model removes
the code and deploys again. Both stores forbid both, so the gate applies to
apps and games.

## Tool execution flow

```
User message
    │
    ▼
Agent loop (agent.ts)
    │
    ├── File tool? → executeTool() locally → result in conversation
    │
    └── Infra tool? → collect, break loop
                          │
                          ▼
                  Session (session.ts)
                      │
                      ├── Auth check: does target ID match session.appId?
                      ├── Execute with env secrets
                      ├── Send SSE tool_result to client
                      └── Feed result into conversation history
```
