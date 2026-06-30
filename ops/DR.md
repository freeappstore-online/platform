# Disaster Recovery Runbook

What to do when production breaks. One-page, scenario-by-scenario. Read the **first** section of any matching scenario; if you're still stuck, escalate.

## What can fail and what's the impact

| Failure | Blast radius | Recovery time |
|---|---|---|
| CF account locked / suspended | Every published app + admin + `api.freeappstore.online` | Hours-to-days (CF support) |
| D1 corruption or accidental drop | All sign-ins, KV, rooms across every app | Minutes (PITR) |
| Bad Worker deploy | `api.freeappstore.online` (auth, KV, rooms) | <2 min (rollback) |
| DNS misconfiguration | One subdomain, or all of `*.freeappstore.online` | 1-30 min |
| GitHub OAuth App revoked / secret rotated | All sign-ins via `fas` SDK | Minutes (re-secret) |
| GitHub repo deleted | One app's source; CF Pages deploys frozen until repo restored | 30 min - hours (GitHub support) |

## Scenario 1: CF account locked or suspended

**Symptom:** Worker deploys fail with auth errors, dashboard inaccessible, custom domains drop.

**Recovery:**
1. Check `https://www.cloudflarestatus.com/` — is it CF, not us?
2. Email Cloudflare support from the admin email; reference the account ID.
3. If account is unrecoverable: the entire stack must be rebuilt on a new account.
   - DNS zones (`freeappstore.online`, `proappstore.online`, etc.) are tied to the account; transfer or re-register at the registrar.
   - Worker source is in `freeappstore-online/platform` repo; re-deploy with `wrangler deploy` after re-creating D1 and DO bindings.
   - Existing user data in D1 is **lost** unless you exported a backup.

**Prevention now:**
- Add a second Cloudflare account admin (Account Members → Invite). Audit P1.
- Use a non-personal admin email tied to a domain you control, not a free Gmail.
- Daily/weekly D1 export to R2 (not yet implemented; see the Backups section below).

## Scenario 2: D1 corruption, accidental drop, bad migration

**Symptom:** Sign-in returns "user not found" for everyone; KV reads return 404; route handlers throw `D1_ERROR` in logs.

**Recovery (point-in-time restore):**
1. Cloudflare D1 supports automatic backups for any D1 database.
   ```bash
   wrangler d1 time-travel info fas
   wrangler d1 time-travel restore fas --timestamp '<ISO-8601 5 minutes before the bad event>'
   ```
2. Verify with `wrangler d1 execute fas --remote --command "SELECT COUNT(*) FROM users"`.
3. If the bad migration is in the migrations table, write a new migration that reverses it; never edit applied migrations.

**Prevention now:**
- Test every migration against `--local` before applying `--remote`.
- Don't run `DROP TABLE` or `wrangler d1 execute --remote` ad hoc — write a migration so it's reproducible.

## Scenario 3: Bad Worker deploy

**Symptom:** `api.freeappstore.online/health` returns 5xx, recent deploy is the trigger.

**Recovery (rollback):**
```bash
# List recent versions:
wrangler versions list

# Roll back to the previous good version:
wrangler rollback [VERSION_ID]
```

A rollback takes effect in seconds. Then identify the actual bug, fix forward, and redeploy.

**Prevention now:**
- `pnpm test && node scripts/e2e-local.mjs` (against `wrangler dev`) before every prod deploy.
- CI green on `main` is necessary but not sufficient — CI doesn't run e2e.

## Scenario 4: DNS misconfiguration

**Symptom:** Subdomain returns SSL errors, NXDOMAIN, or routes to the wrong target.

**Recovery:**
1. Check the DNS record for the affected subdomain in CF dashboard → DNS → `freeappstore.online`.
2. If a Pages custom domain is involved, in dashboard → Workers & Pages → \<project\> → Settings → Domains. Remove and re-add if "Initializing" is stuck longer than 5 min.
3. For Worker custom domains: check `wrangler.toml`'s `[[routes]]` block has `custom_domain = true` and run `wrangler deploy`.

## Scenario 5: GitHub OAuth App revoked or secret leaked

**Symptom:** `/v1/auth/github/start` redirects to GitHub but callback fails with `bad_verification_code` or similar.

**Recovery (secret rotation):**
1. https://github.com/organizations/freeappstore-online/settings/applications/3576238 → Generate a new client secret. Revoke the old one.
2. Update the Worker:
   ```bash
   cd packages/backend
   wrangler secret put GITHUB_CLIENT_SECRET
   # paste the new secret in the prompt — do not put it on the command line
   ```
3. No redeploy needed; secrets bind live.

**Recovery (App revoked):**
- Register a new OAuth App with the same callback URLs.
- Update `GITHUB_CLIENT_ID` in `packages/backend/wrangler.toml` `[vars]` and in `packages/cli/src/commands/login.ts` `DEFAULT_CLIENT_ID`.
- Re-set `GITHUB_CLIENT_SECRET` per above.
- All existing user sessions remain valid (HMAC-signed locally), but new sign-ins will fail until the new App is wired.

## Scenario 6: GitHub repo deleted

**Symptom:** CF Pages auto-deploy fails; the app's source code is gone.

**Recovery:**
- GitHub keeps deleted repos for 90 days. Within that window, contact GitHub support to restore.
- After 90 days, the repo is unrecoverable except from local clones. Every maintainer should keep at least one clone of every active app.

## Where to find what (when you can't access the dashboard)

These values live in places other than the dashboard, so they're recoverable even if your CF account is locked:

| Item | Where it lives |
|---|---|
| CF account ID, zone IDs, admin email | Bitwarden / 1Password (or wherever the team's secrets vault is — **not** in any public repo) |
| Worker source code | `github.com/freeappstore-online/platform` |
| Storefront source code | `github.com/freeappstore-online/freeappstore` |
| Admin Worker source | `github.com/freeappstore-online/admin` |
| Per-app source code | `github.com/freeappstore-online/<app-id>` |
| GitHub OAuth App | `github.com/organizations/freeappstore-online/settings/applications/3576238` (org owner can rotate) |

## Backups (gap to close)

There is **no automated D1 backup** today. Cloudflare's time-travel covers ~30 days but does not survive a CF account loss.

Action item (not yet implemented): a Worker cron that dumps D1 contents to R2 daily, with R2 cross-account replication, so a CF account loss survives.

## Bus factor

This stack is currently maintained by **one person** (the CF account owner). That is the single most likely cause of irrecoverable failure. Highest-leverage prevention is adding a second admin to the CF account, **today**.
