-- FAS cleanup (#545): host routes for apps that were retired or never published.
--
-- Removed: the routes of apps whose repository is archived or gone and that
-- serve nothing (grade-goal, pulse-stack, sky-check, the e2e canaries), `writer`
-- (archived, no build, needs a local Ollama or a Chrome flag), and `spending`,
-- the old id of gcp-spending, which has its own route and deploys under its own
-- id. This is the host half of what POST /api/deprovision does; the `apps` rows
-- go in backend migration 0041.
DELETE FROM routes
 WHERE zone = 'freeappstore.online'
   AND slug IN (
  'e2e-canary-mvl8gve9puci',
  'e2e-canary-mvlx5avfk0zc',
  'grade-goal',
  'pulse-stack',
  'sky-check',
  'spending',
  'writer'
);

-- personality-quiz was deployed from its repo but never published, so every
-- keyless deploy was refused with "app personality-quiz has no route". Same
-- row insertHostRoute writes for a new app (r2 prefix apps/<id>, no release
-- until the first deploy commits one).
INSERT OR IGNORE INTO routes (slug, zone, r2_prefix, store, hosted_on, created_at, updated_at, cross_origin_isolated)
VALUES ('personality-quiz', 'freeappstore.online', 'apps/personality-quiz', 'apps', 'r2', unixepoch() * 1000, unixepoch() * 1000, 0);
