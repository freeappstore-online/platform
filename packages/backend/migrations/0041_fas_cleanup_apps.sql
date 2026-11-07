-- FAS cleanup (#545): ownership rows, deploy pins and sessions for apps that
-- were retired, and the repo of two apps that drifted. The host routes go in
-- workers/host migration 0005. This is the D1 half of POST /api/deprovision
-- (workers/admin/src/deprovision.ts deleteHostRoute), run as a migration
-- because the admin API needs an admin session.
--
-- Retired: grade-goal and pulse-stack (empty repos, now archived, listed in
-- the registry as unavailable), sky-check and the two e2e canaries (archived
-- or deleted repos, nothing served), writer (archived), and `spending`, the
-- old id of gcp-spending (the repo was renamed; gcp-spending has its own
-- apps row, route, pin and deploys, and the registry now lists it).
DELETE FROM app_deploys WHERE app_id IN (
  'e2e-canary-mvl8gve9puci', 'e2e-canary-mvlx5avfk0zc', 'grade-goal',
  'pulse-stack', 'sky-check', 'spending', 'writer'
);
DELETE FROM app_repositories WHERE app_id IN (
  'e2e-canary-mvl8gve9puci', 'e2e-canary-mvlx5avfk0zc', 'grade-goal',
  'pulse-stack', 'sky-check', 'spending', 'writer'
);
DELETE FROM apps WHERE id IN (
  'e2e-canary-mvl8gve9puci', 'e2e-canary-mvlx5avfk0zc', 'grade-goal',
  'pulse-stack', 'sky-check', 'spending', 'writer'
);

-- personality-quiz: the ownership row (SASASKIA) predates the repo's keyless
-- workflow; record the org repo so the first deploy's repo check passes. The
-- owner is not changed.
UPDATE apps
   SET repo = 'https://github.com/freeappstore-online/personality-quiz', store = 'apps'
 WHERE id = 'personality-quiz';

-- gcp-spending: same repo URL form as every other app (0034 wrote the short form).
UPDATE apps
   SET repo = 'https://github.com/freeappstore-online/gcp-spending'
 WHERE id = 'gcp-spending';
