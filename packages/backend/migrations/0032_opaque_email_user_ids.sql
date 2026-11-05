-- #434: user ids must not contain email addresses.
--
-- Magic-link sign-in used to mint `email:<address>`. Every such id is replaced
-- by a fresh random `em:<32 hex>` id that has no relation to the address, in
-- every column that holds a user id and in the free-text columns where the
-- platform or apps write ids. Sign-in keeps finding the account through
-- users (provider = 'email', provider_id = <address>), which the new unique
-- index below enforces.
--
-- Phase 1 code reads both id formats, so this is safe to apply before or after
-- it is live. Phase 2 retires `email:` sessions; email users sign in again once.
--
-- The mapping table holds the addresses, so it is dropped at the end. Rollback is
-- a D1 Time Travel restore to before this migration (see #434).

CREATE TABLE _uid_map_434 (
  n      INTEGER PRIMARY KEY,
  old_id TEXT NOT NULL UNIQUE,
  new_id TEXT NOT NULL UNIQUE
);

-- Every legacy id anywhere, including orphans of deleted accounts. Longest
-- first, so replacing `email:a@x.com` never corrupts `email:a@x.community` in
-- the free-text passes below.
INSERT INTO _uid_map_434 (old_id, new_id)
SELECT old_id, 'em:' || lower(hex(randomblob(16)))
FROM (
  SELECT id AS old_id FROM users
  UNION SELECT user_id FROM kv
  UNION SELECT user_id FROM app_logs
  UNION SELECT user_id FROM user_api_keys
  UNION SELECT provisioned_by FROM user_api_keys
  UNION SELECT user_id FROM agent_sessions
  UNION SELECT owner_id FROM documents
  UNION SELECT user_id FROM app_roles
  UNION SELECT granted_by FROM app_roles
  UNION SELECT user_a FROM friendships
  UNION SELECT user_b FROM friendships
  UNION SELECT initiator FROM friendships
  UNION SELECT blocker FROM friendships
  UNION SELECT user_id FROM app_votes
  UNION SELECT user_id FROM complimentary_grants
  UNION SELECT granted_by FROM complimentary_grants
  UNION SELECT user_id FROM push_subscriptions
  UNION SELECT user_id FROM push_schedules
  UNION SELECT user_id FROM idea_builders
  UNION SELECT owner_id FROM data_rooms
  UNION SELECT user_id FROM data_room_members
)
WHERE old_id LIKE 'email:%'
ORDER BY length(old_id) DESC, old_id;

-- Columns that hold exactly one user id.
UPDATE users SET id = (SELECT new_id FROM _uid_map_434 WHERE old_id = users.id) WHERE id IN (SELECT old_id FROM _uid_map_434);
UPDATE kv SET user_id = (SELECT new_id FROM _uid_map_434 WHERE old_id = kv.user_id) WHERE user_id IN (SELECT old_id FROM _uid_map_434);
UPDATE app_logs SET user_id = (SELECT new_id FROM _uid_map_434 WHERE old_id = app_logs.user_id) WHERE user_id IN (SELECT old_id FROM _uid_map_434);
UPDATE user_api_keys SET user_id = (SELECT new_id FROM _uid_map_434 WHERE old_id = user_api_keys.user_id) WHERE user_id IN (SELECT old_id FROM _uid_map_434);
UPDATE user_api_keys SET provisioned_by = (SELECT new_id FROM _uid_map_434 WHERE old_id = user_api_keys.provisioned_by) WHERE provisioned_by IN (SELECT old_id FROM _uid_map_434);
UPDATE agent_sessions SET user_id = (SELECT new_id FROM _uid_map_434 WHERE old_id = agent_sessions.user_id) WHERE user_id IN (SELECT old_id FROM _uid_map_434);
UPDATE documents SET owner_id = (SELECT new_id FROM _uid_map_434 WHERE old_id = documents.owner_id) WHERE owner_id IN (SELECT old_id FROM _uid_map_434);
UPDATE app_roles SET user_id = (SELECT new_id FROM _uid_map_434 WHERE old_id = app_roles.user_id) WHERE user_id IN (SELECT old_id FROM _uid_map_434);
UPDATE app_roles SET granted_by = (SELECT new_id FROM _uid_map_434 WHERE old_id = app_roles.granted_by) WHERE granted_by IN (SELECT old_id FROM _uid_map_434);
UPDATE app_votes SET user_id = (SELECT new_id FROM _uid_map_434 WHERE old_id = app_votes.user_id) WHERE user_id IN (SELECT old_id FROM _uid_map_434);
UPDATE complimentary_grants SET user_id = (SELECT new_id FROM _uid_map_434 WHERE old_id = complimentary_grants.user_id) WHERE user_id IN (SELECT old_id FROM _uid_map_434);
UPDATE complimentary_grants SET granted_by = (SELECT new_id FROM _uid_map_434 WHERE old_id = complimentary_grants.granted_by) WHERE granted_by IN (SELECT old_id FROM _uid_map_434);
UPDATE push_subscriptions SET user_id = (SELECT new_id FROM _uid_map_434 WHERE old_id = push_subscriptions.user_id) WHERE user_id IN (SELECT old_id FROM _uid_map_434);
UPDATE push_schedules SET user_id = (SELECT new_id FROM _uid_map_434 WHERE old_id = push_schedules.user_id) WHERE user_id IN (SELECT old_id FROM _uid_map_434);
UPDATE idea_builders SET user_id = (SELECT new_id FROM _uid_map_434 WHERE old_id = idea_builders.user_id) WHERE user_id IN (SELECT old_id FROM _uid_map_434);
UPDATE data_rooms SET owner_id = (SELECT new_id FROM _uid_map_434 WHERE old_id = data_rooms.owner_id) WHERE owner_id IN (SELECT old_id FROM _uid_map_434);
UPDATE data_room_members SET user_id = (SELECT new_id FROM _uid_map_434 WHERE old_id = data_room_members.user_id) WHERE user_id IN (SELECT old_id FROM _uid_map_434);

-- friendships keeps CHECK (user_a < user_b); new ids can reverse a pair's
-- order, so both ends are recomputed together from the old row.
UPDATE friendships SET
  user_a = min(
    coalesce((SELECT new_id FROM _uid_map_434 WHERE old_id = user_a), user_a),
    coalesce((SELECT new_id FROM _uid_map_434 WHERE old_id = user_b), user_b)),
  user_b = max(
    coalesce((SELECT new_id FROM _uid_map_434 WHERE old_id = user_a), user_a),
    coalesce((SELECT new_id FROM _uid_map_434 WHERE old_id = user_b), user_b)),
  initiator = coalesce((SELECT new_id FROM _uid_map_434 WHERE old_id = initiator), initiator),
  blocker = coalesce((SELECT new_id FROM _uid_map_434 WHERE old_id = blocker), blocker)
WHERE user_a IN (SELECT old_id FROM _uid_map_434) OR user_b IN (SELECT old_id FROM _uid_map_434);

-- Free text where ids are embedded (app JSON, counter keys, room names, quota
-- keys `email-user:<uid>` / `userkey:<uid>`, webhook payloads, logs). Each
-- matching value runs through every mapping in order.
UPDATE documents SET data = (WITH RECURSIVE r(n, s) AS (SELECT 0, documents.data UNION ALL SELECT m.n, replace(r.s, m.old_id, m.new_id) FROM r JOIN _uid_map_434 m ON m.n = r.n + 1) SELECT s FROM r ORDER BY n DESC LIMIT 1) WHERE instr(data, 'email:') > 0;
UPDATE data_room_documents SET data = (WITH RECURSIVE r(n, s) AS (SELECT 0, data_room_documents.data UNION ALL SELECT m.n, replace(r.s, m.old_id, m.new_id) FROM r JOIN _uid_map_434 m ON m.n = r.n + 1) SELECT s FROM r ORDER BY n DESC LIMIT 1) WHERE instr(data, 'email:') > 0;
UPDATE counters SET key = (WITH RECURSIVE r(n, s) AS (SELECT 0, counters.key UNION ALL SELECT m.n, replace(r.s, m.old_id, m.new_id) FROM r JOIN _uid_map_434 m ON m.n = r.n + 1) SELECT s FROM r ORDER BY n DESC LIMIT 1) WHERE instr(key, 'email:') > 0;
UPDATE app_rooms SET room_id = (WITH RECURSIVE r(n, s) AS (SELECT 0, app_rooms.room_id UNION ALL SELECT m.n, replace(r.s, m.old_id, m.new_id) FROM r JOIN _uid_map_434 m ON m.n = r.n + 1) SELECT s FROM r ORDER BY n DESC LIMIT 1) WHERE instr(room_id, 'email:') > 0;
UPDATE app_proxy_usage SET app_id = (WITH RECURSIVE r(n, s) AS (SELECT 0, app_proxy_usage.app_id UNION ALL SELECT m.n, replace(r.s, m.old_id, m.new_id) FROM r JOIN _uid_map_434 m ON m.n = r.n + 1) SELECT s FROM r ORDER BY n DESC LIMIT 1) WHERE instr(app_id, 'email:') > 0;
UPDATE webhook_deliveries SET payload = (WITH RECURSIVE r(n, s) AS (SELECT 0, webhook_deliveries.payload UNION ALL SELECT m.n, replace(r.s, m.old_id, m.new_id) FROM r JOIN _uid_map_434 m ON m.n = r.n + 1) SELECT s FROM r ORDER BY n DESC LIMIT 1) WHERE instr(payload, 'email:') > 0;
UPDATE app_logs SET message = (WITH RECURSIVE r(n, s) AS (SELECT 0, app_logs.message UNION ALL SELECT m.n, replace(r.s, m.old_id, m.new_id) FROM r JOIN _uid_map_434 m ON m.n = r.n + 1) SELECT s FROM r ORDER BY n DESC LIMIT 1) WHERE instr(message, 'email:') > 0;
UPDATE app_logs SET data = (WITH RECURSIVE r(n, s) AS (SELECT 0, app_logs.data UNION ALL SELECT m.n, replace(r.s, m.old_id, m.new_id) FROM r JOIN _uid_map_434 m ON m.n = r.n + 1) SELECT s FROM r ORDER BY n DESC LIMIT 1) WHERE instr(data, 'email:') > 0;
UPDATE error_log SET message = (WITH RECURSIVE r(n, s) AS (SELECT 0, error_log.message UNION ALL SELECT m.n, replace(r.s, m.old_id, m.new_id) FROM r JOIN _uid_map_434 m ON m.n = r.n + 1) SELECT s FROM r ORDER BY n DESC LIMIT 1) WHERE instr(message, 'email:') > 0;
UPDATE error_log SET context = (WITH RECURSIVE r(n, s) AS (SELECT 0, error_log.context UNION ALL SELECT m.n, replace(r.s, m.old_id, m.new_id) FROM r JOIN _uid_map_434 m ON m.n = r.n + 1) SELECT s FROM r ORDER BY n DESC LIMIT 1) WHERE instr(context, 'email:') > 0;

-- kv.value is a BLOB holding app JSON. Binary values (any NUL byte) are left
-- alone and show up in the verification query instead.
UPDATE kv SET value = CAST((WITH RECURSIVE r(n, s) AS (SELECT 0, CAST(kv.value AS TEXT) UNION ALL SELECT m.n, replace(r.s, m.old_id, m.new_id) FROM r JOIN _uid_map_434 m ON m.n = r.n + 1) SELECT s FROM r ORDER BY n DESC LIMIT 1) AS BLOB)
WHERE instr(value, CAST('email:' AS BLOB)) > 0 AND instr(value, X'00') = 0;
UPDATE kv SET value_size_bytes = length(value) WHERE typeof(value) = 'blob' AND value_size_bytes <> length(value);

-- One-time PKCE codes hold a whole session token, whose payload carries the
-- uid. They live for minutes; drop them rather than rewrite signed tokens.
DELETE FROM auth_codes;

DROP TABLE _uid_map_434;

-- Sign-in looks the account up by address; one account per address.
CREATE UNIQUE INDEX IF NOT EXISTS idx_users_email_identity ON users (provider_id) WHERE provider = 'email';

-- Non-GitHub accounts defaulted their login and display name to the email
-- local part, which reaches every app and room peer. Where a name still is
-- that default it becomes `user-<4 hex>`, the default new accounts now get.
-- A name that came from the provider (Google / Apple profile) is kept.
UPDATE users SET github_login = 'user-' || lower(hex(randomblob(2)))
WHERE provider IN ('google', 'apple', 'email') AND email IS NOT NULL
  AND github_login = substr(email, 1, instr(email, '@') - 1);
UPDATE users SET display_name = github_login
WHERE provider IN ('google', 'apple', 'email') AND email IS NOT NULL
  AND display_name = substr(email, 1, instr(email, '@') - 1);
