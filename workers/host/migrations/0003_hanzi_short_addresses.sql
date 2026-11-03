-- Short public addresses share the existing deployment prefixes. Keep the old
-- origins working: Hanzi practice history is stored in origin-local storage.
-- Do not overwrite an existing route if a short name has already been claimed.
INSERT INTO routes (slug, zone, r2_prefix, store, hosted_on, created_at, updated_at, cross_origin_isolated)
SELECT 'hanzi', zone, r2_prefix, store, hosted_on, unixepoch(), unixepoch(), cross_origin_isolated
FROM routes WHERE slug = 'hanzi-practice' AND zone = 'freeappstore.online';

INSERT INTO routes (slug, zone, r2_prefix, store, hosted_on, created_at, updated_at, cross_origin_isolated)
SELECT 'yi', zone, r2_prefix, store, hosted_on, unixepoch(), unixepoch(), cross_origin_isolated
FROM routes WHERE slug = 'hanzi-associations' AND zone = 'freeappstore.online';
