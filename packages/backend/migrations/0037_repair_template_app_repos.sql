-- Repair apps.repo rows that record the template an app was created from
-- instead of the app's own repository (found rolling out keyless deploys,
-- #460: agentcoder was recorded as freeappstore-online/template-standalone, so
-- its first keyless deploy was refused with "registered to ...").
-- Every FAS app's repository is freeappstore-online/<app id>.
UPDATE apps
   SET repo = 'https://github.com/freeappstore-online/' || id
 WHERE (store IS NULL OR store = 'apps')
   AND lower(repo) LIKE '%freeappstore-online/template-%'
   AND id NOT LIKE 'template-%';
