-- Backfill the ownership row for 13 live apps that had a host route but no
-- `apps` row (#512). Without the row appExists() is false, so every per-app
-- backend feature (room tickets, kv, push, roles, logs, …) answered
-- `404 unknown app` — meet could not start a meeting.
--
-- They were provisioned before the route + ownership write became one batch
-- (workers/admin/src/publish.ts insertHostRoute/claimAppStmt): the old
-- best-effort `apps` insert dropped them silently.
--
-- Owner: serge-ivo. Every commit to these repos is by serge-ivo or
-- serge-the-dev, the console signs in as serge-ivo, and every other app in
-- this position (hanzi-practice, kanban, notes, … — committed to mostly by
-- serge-the-dev) is owned by serge-ivo. serge-the-dev is the canary account
-- and owns only smoke-sandbox and the e2e-canary-* apps.
--
-- Columns follow claimAppStmt. None of these ids is in the storefront
-- registry, so category, type and oneliner stay NULL rather than guessed.
-- created_at is the app's `routes.created_at`, in milliseconds.
--
-- Not backfilled: the reserved hosts and aliases (console, create, hanzi, yi)
-- and `pathb`, the Path B smoke-test route with no repo, left to #512.
-- INSERT OR IGNORE: an owner recorded since is never overwritten.
INSERT OR IGNORE INTO apps (id, owner_login, created_at, category, type, oneliner, repo, demo, store) VALUES
  ('calendar',                 'serge-ivo', 1779538587000, NULL, NULL, NULL, 'freeappstore-online/calendar',                 NULL, 'apps'),
  ('gcp-spending',             'serge-ivo', 1779739356000, NULL, NULL, NULL, 'freeappstore-online/gcp-spending',             NULL, 'apps'),
  ('hello-world',              'serge-ivo', 1780128371000, NULL, NULL, NULL, 'freeappstore-online/hello-world',              NULL, 'apps'),
  ('joke-generator',           'serge-ivo', 1780128371000, NULL, NULL, NULL, 'freeappstore-online/joke-generator',           NULL, 'apps'),
  ('kpop-concert-tracker',     'serge-ivo', 1780127240000, NULL, NULL, NULL, 'freeappstore-online/kpop-concert-tracker',     NULL, 'apps'),
  ('meet',                     'serge-ivo', 1779514231000, NULL, NULL, NULL, 'freeappstore-online/meet',                     NULL, 'apps'),
  ('messenger',                'serge-ivo', 1780128371000, NULL, NULL, NULL, 'freeappstore-online/messenger',                NULL, 'apps'),
  ('simple-todo',              'serge-ivo', 1780128371000, NULL, NULL, NULL, 'freeappstore-online/simple-todo',              NULL, 'apps'),
  ('simple-weather',           'serge-ivo', 1780128371000, NULL, NULL, NULL, 'freeappstore-online/simple-weather',           NULL, 'apps'),
  ('todo',                     'serge-ivo', 1780128371000, NULL, NULL, NULL, 'freeappstore-online/todo',                     NULL, 'apps'),
  ('travel-packing-checklist', 'serge-ivo', 1780127234000, NULL, NULL, NULL, 'freeappstore-online/travel-packing-checklist', NULL, 'apps'),
  ('unit-converter',           'serge-ivo', 1780128371000, NULL, NULL, NULL, 'freeappstore-online/unit-converter',           NULL, 'apps'),
  ('writer',                   'serge-ivo', 1780637298000, NULL, NULL, NULL, 'freeappstore-online/writer',                   NULL, 'apps');
