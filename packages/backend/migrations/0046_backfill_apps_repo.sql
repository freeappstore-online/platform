-- Backfill apps.repo (#554). 130 store 'apps' rows had repo NULL: the VibeCode
-- claim (workers/agent claimApp) inserted the row without it, and /v1/publish
-- used INSERT OR IGNORE with the client's repo (usually absent), so the later
-- publish never filled it in. Both now write the org URL (#546, #554).
-- Every affected row is pinned in app_repositories to freeappstore-online/<id>
-- (migration 0036), so the URL is derived from the app's own pin. Idempotent.
UPDATE apps
   SET repo = 'https://github.com/' || (
     SELECT r.repository FROM app_repositories r WHERE r.app_id = apps.id
   )
 WHERE store = 'apps'
   AND repo IS NULL
   AND id IN (
     SELECT app_id FROM app_repositories WHERE repository = 'freeappstore-online/' || app_id
   );
