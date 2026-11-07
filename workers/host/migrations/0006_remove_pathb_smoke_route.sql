-- The `pathb` route was the Path B host smoke test (2026-05-21): a static page
-- "Path B smoke test" in r2://fas-apps/apps/pathb, no repo, no apps row, no
-- release (#554, fleet audit route-without-apps). Backed up before deletion.
DELETE FROM routes WHERE zone = 'freeappstore.online' AND slug = 'pathb';
