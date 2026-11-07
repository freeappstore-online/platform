# Access & identities

Who can reach the FreeAppStore GitHub org, and how to check it. Written after #9,
where a work account turned up as a direct collaborator on `platform`.

## Rules

- **Platform repos are owner-only.** `platform`, `admin`, `agent`, `mcp`, `host`,
  `console`, `create`, `publisher`, `freeappstore` and every `template-*` repo get
  access only through **org ownership**. No direct collaborators, no outside
  collaborators.
- **The only automated grant is a creator's push access to their own app repo.**
  Publishing (`fas publish`, the console, VibeCode) invites the creator as a
  `push` collaborator on `freeappstore-online/<app-id>`. The publish flow refuses
  platform repo names, and re-publishing an existing repo only works for the
  app's recorded owner (`apps.owner_login`). Nothing else in the code adds anyone
  to a repo or to the org.
- **Personal and work identities never cross.** A work GitHub account
  (e.g. `*-rocketlab`) must never be added to any store org (`freeappstore-online`,
  `freegamestore-online`, `proappstore-online`, `progamestore-online`,
  `freewebstore-online`, `prowebstore-online`) or to personal repos. Store work
  happens as `serge-ivo` under `~/dev/**`; the per-tree account switching keeps
  `gh`/git on the right identity. Don't `gh auth switch` by hand.
- Members can't create repos in the store orgs (`members_can_create_repositories:
  false`); leave it that way.

## Checking

**Weekly, automatically:** `.github/workflows/collaborator-audit.yml` lists direct
collaborators and pending invitations on the platform repos and fails if there
are any. It needs the `GH_AUDIT_TOKEN` secret (see the workflow for the exact
read-only permissions); until it's set, the workflow only warns.

**By hand**, as an org owner (`serge-ivo`):

```bash
# Direct collaborators and pending invitations on every platform repo (expect none).
for r in platform admin agent mcp host console create publisher freeappstore \
         $(gh api "orgs/freeappstore-online/repos?per_page=100" --paginate --jq '.[].name | select(startswith("template-"))'); do
  printf '%-22s collaborators=[%s] invitations=[%s]\n' "$r" \
    "$(gh api "repos/freeappstore-online/$r/collaborators?affiliation=direct" --jq '[.[].login]|join(",")')" \
    "$(gh api "repos/freeappstore-online/$r/invitations" --jq '[.[].invitee.login]|join(",")')"
done
```

The same loop over `$(gh api "user/repos?affiliation=owner&per_page=100" --paginate --jq '.[].full_name')`
(using `repos/$r/...`) sweeps personal repos.

**When and how someone was added** is only in the org **audit log**: GitHub web UI →
org **Settings → Audit log**, filter e.g. `action:repo.add_member` or
`action:org.add_member`. The audit-log REST API is Enterprise-only; on the free
plan it returns 404. Old events age out, so check promptly.

## Fleet consistency audit

`.github/workflows/fleet-consistency-audit.yml` (daily and on demand) runs
`scripts/fleet-consistency-audit.mjs` and keeps one `verification` issue,
"Fleet consistency audit findings", up to date (#552). It is read-only: it lists
org repos and reads their files with the workflow's own `github.token`, probes
each listed site with `HEAD`, and writes nothing except that issue. Repos that
are tooling, not apps, are listed in `config/non-app-repos.json`.

**D1 checks need a credential, and one has not been chosen.** `apps` and
`routes` rows are only readable through `GET /v1/admin/apps`, which requires a
signed-in platform admin (`requireAdmin`); there is no read-only service
credential. Until one is decided, the audit runs those checks only if the
repository secret `FAS_AUDIT_ADMIN_TOKEN` exists (a fas session of an admin
account; sessions last 30 days, so it needs renewing) and otherwise says in its
report that they were skipped. It sends the token only to
`https://api.freeappstore.online/v1/admin/apps` and never prints it. A proper
fix is a dedicated read-only audit endpoint with its own token, which changes
the auth surface and is for the owner to decide.
