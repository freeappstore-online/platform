-- #434 verification, read-only: every D1 text column that still holds an
-- `email:<address>` user id. Every statement should return no rows after
-- 0032_opaque_email_user_ids. Prints counts only, never values.
-- Run (from packages/backend; --file would print only a batch summary, and the
-- leading comment lines must be stripped or wrangler reads them as flags):
--   wrangler d1 execute fas --remote --json --command "$(grep -v '^--' scripts/verify-434-no-email-ids.sql)"
-- Encrypted key columns are skipped; they cannot hold a plaintext id.
-- D1 allows at most 5 terms per compound SELECT, hence the chunks.
SELECT tbl, col, n FROM (
  SELECT 'agent_sessions' AS tbl, 'session_id' AS col, count(*) AS n FROM agent_sessions WHERE session_id LIKE '%email:%@%'
  UNION ALL SELECT 'agent_sessions' AS tbl, 'user_id' AS col, count(*) AS n FROM agent_sessions WHERE user_id LIKE '%email:%@%'
  UNION ALL SELECT 'agent_sessions' AS tbl, 'name' AS col, count(*) AS n FROM agent_sessions WHERE name LIKE '%email:%@%'
  UNION ALL SELECT 'agent_sessions' AS tbl, 'app_id' AS col, count(*) AS n FROM agent_sessions WHERE app_id LIKE '%email:%@%'
  UNION ALL SELECT 'agent_sessions' AS tbl, 'app_url' AS col, count(*) AS n FROM agent_sessions WHERE app_url LIKE '%email:%@%'
) WHERE n > 0;
SELECT tbl, col, n FROM (
  SELECT 'agent_sessions' AS tbl, 'messages' AS col, count(*) AS n FROM agent_sessions WHERE messages LIKE '%email:%@%'
  UNION ALL SELECT 'agent_sessions' AS tbl, 'deploy_state' AS col, count(*) AS n FROM agent_sessions WHERE deploy_state LIKE '%email:%@%'
  UNION ALL SELECT 'agent_sessions' AS tbl, 'deploy_log' AS col, count(*) AS n FROM agent_sessions WHERE deploy_log LIKE '%email:%@%'
  UNION ALL SELECT 'agent_sessions' AS tbl, 'errors' AS col, count(*) AS n FROM agent_sessions WHERE errors LIKE '%email:%@%'
  UNION ALL SELECT 'agent_sessions' AS tbl, 'ai_provider' AS col, count(*) AS n FROM agent_sessions WHERE ai_provider LIKE '%email:%@%'
) WHERE n > 0;
SELECT tbl, col, n FROM (
  SELECT 'agent_sessions' AS tbl, 'ai_model' AS col, count(*) AS n FROM agent_sessions WHERE ai_model LIKE '%email:%@%'
  UNION ALL SELECT 'agent_sessions' AS tbl, 'ai_source' AS col, count(*) AS n FROM agent_sessions WHERE ai_source LIKE '%email:%@%'
  UNION ALL SELECT 'app_analytics' AS tbl, 'app_id' AS col, count(*) AS n FROM app_analytics WHERE app_id LIKE '%email:%@%'
  UNION ALL SELECT 'app_analytics' AS tbl, 'cf_beacon_token' AS col, count(*) AS n FROM app_analytics WHERE cf_beacon_token LIKE '%email:%@%'
  UNION ALL SELECT 'app_analytics' AS tbl, 'ga4' AS col, count(*) AS n FROM app_analytics WHERE ga4 LIKE '%email:%@%'
) WHERE n > 0;
SELECT tbl, col, n FROM (
  SELECT 'app_analytics' AS tbl, 'plausible' AS col, count(*) AS n FROM app_analytics WHERE plausible LIKE '%email:%@%'
  UNION ALL SELECT 'app_analytics' AS tbl, 'custom_head' AS col, count(*) AS n FROM app_analytics WHERE custom_head LIKE '%email:%@%'
  UNION ALL SELECT 'app_logs' AS tbl, 'app_id' AS col, count(*) AS n FROM app_logs WHERE app_id LIKE '%email:%@%'
  UNION ALL SELECT 'app_logs' AS tbl, 'user_id' AS col, count(*) AS n FROM app_logs WHERE user_id LIKE '%email:%@%'
  UNION ALL SELECT 'app_logs' AS tbl, 'level' AS col, count(*) AS n FROM app_logs WHERE level LIKE '%email:%@%'
) WHERE n > 0;
SELECT tbl, col, n FROM (
  SELECT 'app_logs' AS tbl, 'category' AS col, count(*) AS n FROM app_logs WHERE category LIKE '%email:%@%'
  UNION ALL SELECT 'app_logs' AS tbl, 'message' AS col, count(*) AS n FROM app_logs WHERE message LIKE '%email:%@%'
  UNION ALL SELECT 'app_logs' AS tbl, 'data' AS col, count(*) AS n FROM app_logs WHERE data LIKE '%email:%@%'
  UNION ALL SELECT 'app_logs' AS tbl, 'build_meta' AS col, count(*) AS n FROM app_logs WHERE build_meta LIKE '%email:%@%'
  UNION ALL SELECT 'app_owner_transfers' AS tbl, 'app_id' AS col, count(*) AS n FROM app_owner_transfers WHERE app_id LIKE '%email:%@%'
) WHERE n > 0;
SELECT tbl, col, n FROM (
  SELECT 'app_owner_transfers' AS tbl, 'from_login' AS col, count(*) AS n FROM app_owner_transfers WHERE from_login LIKE '%email:%@%'
  UNION ALL SELECT 'app_owner_transfers' AS tbl, 'to_login' AS col, count(*) AS n FROM app_owner_transfers WHERE to_login LIKE '%email:%@%'
  UNION ALL SELECT 'app_owner_transfers' AS tbl, 'reason' AS col, count(*) AS n FROM app_owner_transfers WHERE reason LIKE '%email:%@%'
  UNION ALL SELECT 'app_owner_transfers' AS tbl, 'actor_login' AS col, count(*) AS n FROM app_owner_transfers WHERE actor_login LIKE '%email:%@%'
  UNION ALL SELECT 'app_proxy_allowlist' AS tbl, 'app_id' AS col, count(*) AS n FROM app_proxy_allowlist WHERE app_id LIKE '%email:%@%'
) WHERE n > 0;
SELECT tbl, col, n FROM (
  SELECT 'app_proxy_allowlist' AS tbl, 'pattern' AS col, count(*) AS n FROM app_proxy_allowlist WHERE pattern LIKE '%email:%@%'
  UNION ALL SELECT 'app_proxy_allowlist' AS tbl, 'inject_kind' AS col, count(*) AS n FROM app_proxy_allowlist WHERE inject_kind LIKE '%email:%@%'
  UNION ALL SELECT 'app_proxy_allowlist' AS tbl, 'inject_name' AS col, count(*) AS n FROM app_proxy_allowlist WHERE inject_name LIKE '%email:%@%'
  UNION ALL SELECT 'app_proxy_allowlist' AS tbl, 'secret_name' AS col, count(*) AS n FROM app_proxy_allowlist WHERE secret_name LIKE '%email:%@%'
  UNION ALL SELECT 'app_proxy_allowlist' AS tbl, 'methods' AS col, count(*) AS n FROM app_proxy_allowlist WHERE methods LIKE '%email:%@%'
) WHERE n > 0;
SELECT tbl, col, n FROM (
  SELECT 'app_proxy_allowlist' AS tbl, 'secret_name_2' AS col, count(*) AS n FROM app_proxy_allowlist WHERE secret_name_2 LIKE '%email:%@%'
  UNION ALL SELECT 'app_proxy_allowlist' AS tbl, 'token_url' AS col, count(*) AS n FROM app_proxy_allowlist WHERE token_url LIKE '%email:%@%'
  UNION ALL SELECT 'app_proxy_usage' AS tbl, 'app_id' AS col, count(*) AS n FROM app_proxy_usage WHERE app_id LIKE '%email:%@%'
  UNION ALL SELECT 'app_proxy_usage' AS tbl, 'day' AS col, count(*) AS n FROM app_proxy_usage WHERE day LIKE '%email:%@%'
  UNION ALL SELECT 'app_roles' AS tbl, 'app_id' AS col, count(*) AS n FROM app_roles WHERE app_id LIKE '%email:%@%'
) WHERE n > 0;
SELECT tbl, col, n FROM (
  SELECT 'app_roles' AS tbl, 'user_id' AS col, count(*) AS n FROM app_roles WHERE user_id LIKE '%email:%@%'
  UNION ALL SELECT 'app_roles' AS tbl, 'role_name' AS col, count(*) AS n FROM app_roles WHERE role_name LIKE '%email:%@%'
  UNION ALL SELECT 'app_roles' AS tbl, 'granted_by' AS col, count(*) AS n FROM app_roles WHERE granted_by LIKE '%email:%@%'
  UNION ALL SELECT 'app_rooms' AS tbl, 'app_id' AS col, count(*) AS n FROM app_rooms WHERE app_id LIKE '%email:%@%'
  UNION ALL SELECT 'app_rooms' AS tbl, 'room_id' AS col, count(*) AS n FROM app_rooms WHERE room_id LIKE '%email:%@%'
) WHERE n > 0;
SELECT tbl, col, n FROM (
  SELECT 'app_secrets' AS tbl, 'app_id' AS col, count(*) AS n FROM app_secrets WHERE app_id LIKE '%email:%@%'
  UNION ALL SELECT 'app_secrets' AS tbl, 'name' AS col, count(*) AS n FROM app_secrets WHERE name LIKE '%email:%@%'
  UNION ALL SELECT 'app_votes' AS tbl, 'app_id' AS col, count(*) AS n FROM app_votes WHERE app_id LIKE '%email:%@%'
  UNION ALL SELECT 'app_votes' AS tbl, 'user_id' AS col, count(*) AS n FROM app_votes WHERE user_id LIKE '%email:%@%'
  UNION ALL SELECT 'app_webhooks' AS tbl, 'id' AS col, count(*) AS n FROM app_webhooks WHERE id LIKE '%email:%@%'
) WHERE n > 0;
SELECT tbl, col, n FROM (
  SELECT 'app_webhooks' AS tbl, 'app_id' AS col, count(*) AS n FROM app_webhooks WHERE app_id LIKE '%email:%@%'
  UNION ALL SELECT 'app_webhooks' AS tbl, 'event' AS col, count(*) AS n FROM app_webhooks WHERE event LIKE '%email:%@%'
  UNION ALL SELECT 'app_webhooks' AS tbl, 'url' AS col, count(*) AS n FROM app_webhooks WHERE url LIKE '%email:%@%'
  UNION ALL SELECT 'app_webhooks' AS tbl, 'secret' AS col, count(*) AS n FROM app_webhooks WHERE secret LIKE '%email:%@%'
  UNION ALL SELECT 'apps' AS tbl, 'id' AS col, count(*) AS n FROM apps WHERE id LIKE '%email:%@%'
) WHERE n > 0;
SELECT tbl, col, n FROM (
  SELECT 'apps' AS tbl, 'owner_login' AS col, count(*) AS n FROM apps WHERE owner_login LIKE '%email:%@%'
  UNION ALL SELECT 'apps' AS tbl, 'category' AS col, count(*) AS n FROM apps WHERE category LIKE '%email:%@%'
  UNION ALL SELECT 'apps' AS tbl, 'type' AS col, count(*) AS n FROM apps WHERE type LIKE '%email:%@%'
  UNION ALL SELECT 'apps' AS tbl, 'oneliner' AS col, count(*) AS n FROM apps WHERE oneliner LIKE '%email:%@%'
  UNION ALL SELECT 'apps' AS tbl, 'repo' AS col, count(*) AS n FROM apps WHERE repo LIKE '%email:%@%'
) WHERE n > 0;
SELECT tbl, col, n FROM (
  SELECT 'apps' AS tbl, 'demo' AS col, count(*) AS n FROM apps WHERE demo LIKE '%email:%@%'
  UNION ALL SELECT 'apps' AS tbl, 'store' AS col, count(*) AS n FROM apps WHERE store LIKE '%email:%@%'
  UNION ALL SELECT 'audit_results' AS tbl, 'app_id' AS col, count(*) AS n FROM audit_results WHERE app_id LIKE '%email:%@%'
  UNION ALL SELECT 'audit_results' AS tbl, 'store' AS col, count(*) AS n FROM audit_results WHERE store LIKE '%email:%@%'
  UNION ALL SELECT 'audit_results' AS tbl, 'check_name' AS col, count(*) AS n FROM audit_results WHERE check_name LIKE '%email:%@%'
) WHERE n > 0;
SELECT tbl, col, n FROM (
  SELECT 'audit_results' AS tbl, 'status' AS col, count(*) AS n FROM audit_results WHERE status LIKE '%email:%@%'
  UNION ALL SELECT 'audit_results' AS tbl, 'detail' AS col, count(*) AS n FROM audit_results WHERE detail LIKE '%email:%@%'
  UNION ALL SELECT 'auth_codes' AS tbl, 'code_hash' AS col, count(*) AS n FROM auth_codes WHERE code_hash LIKE '%email:%@%'
  UNION ALL SELECT 'auth_codes' AS tbl, 'session' AS col, count(*) AS n FROM auth_codes WHERE session LIKE '%email:%@%'
  UNION ALL SELECT 'auth_codes' AS tbl, 'app_id' AS col, count(*) AS n FROM auth_codes WHERE app_id LIKE '%email:%@%'
) WHERE n > 0;
SELECT tbl, col, n FROM (
  SELECT 'auth_codes' AS tbl, 'code_challenge' AS col, count(*) AS n FROM auth_codes WHERE code_challenge LIKE '%email:%@%'
  UNION ALL SELECT 'complimentary_grants' AS tbl, 'user_id' AS col, count(*) AS n FROM complimentary_grants WHERE user_id LIKE '%email:%@%'
  UNION ALL SELECT 'complimentary_grants' AS tbl, 'provider' AS col, count(*) AS n FROM complimentary_grants WHERE provider LIKE '%email:%@%'
  UNION ALL SELECT 'complimentary_grants' AS tbl, 'model' AS col, count(*) AS n FROM complimentary_grants WHERE model LIKE '%email:%@%'
  UNION ALL SELECT 'complimentary_grants' AS tbl, 'granted_by' AS col, count(*) AS n FROM complimentary_grants WHERE granted_by LIKE '%email:%@%'
) WHERE n > 0;
SELECT tbl, col, n FROM (
  SELECT 'complimentary_grants' AS tbl, 'note' AS col, count(*) AS n FROM complimentary_grants WHERE note LIKE '%email:%@%'
  UNION ALL SELECT 'complimentary_grants' AS tbl, 'expires_at' AS col, count(*) AS n FROM complimentary_grants WHERE expires_at LIKE '%email:%@%'
  UNION ALL SELECT 'consumed_tokens' AS tbl, 'hash' AS col, count(*) AS n FROM consumed_tokens WHERE hash LIKE '%email:%@%'
  UNION ALL SELECT 'counters' AS tbl, 'app_id' AS col, count(*) AS n FROM counters WHERE app_id LIKE '%email:%@%'
  UNION ALL SELECT 'counters' AS tbl, 'key' AS col, count(*) AS n FROM counters WHERE key LIKE '%email:%@%'
) WHERE n > 0;
SELECT tbl, col, n FROM (
  SELECT 'data_room_documents' AS tbl, 'app_id' AS col, count(*) AS n FROM data_room_documents WHERE app_id LIKE '%email:%@%'
  UNION ALL SELECT 'data_room_documents' AS tbl, 'room_id' AS col, count(*) AS n FROM data_room_documents WHERE room_id LIKE '%email:%@%'
  UNION ALL SELECT 'data_room_documents' AS tbl, 'collection' AS col, count(*) AS n FROM data_room_documents WHERE collection LIKE '%email:%@%'
  UNION ALL SELECT 'data_room_documents' AS tbl, 'id' AS col, count(*) AS n FROM data_room_documents WHERE id LIKE '%email:%@%'
  UNION ALL SELECT 'data_room_documents' AS tbl, 'data' AS col, count(*) AS n FROM data_room_documents WHERE data LIKE '%email:%@%'
) WHERE n > 0;
SELECT tbl, col, n FROM (
  SELECT 'data_room_members' AS tbl, 'app_id' AS col, count(*) AS n FROM data_room_members WHERE app_id LIKE '%email:%@%'
  UNION ALL SELECT 'data_room_members' AS tbl, 'room_id' AS col, count(*) AS n FROM data_room_members WHERE room_id LIKE '%email:%@%'
  UNION ALL SELECT 'data_room_members' AS tbl, 'user_id' AS col, count(*) AS n FROM data_room_members WHERE user_id LIKE '%email:%@%'
  UNION ALL SELECT 'data_rooms' AS tbl, 'app_id' AS col, count(*) AS n FROM data_rooms WHERE app_id LIKE '%email:%@%'
  UNION ALL SELECT 'data_rooms' AS tbl, 'id' AS col, count(*) AS n FROM data_rooms WHERE id LIKE '%email:%@%'
) WHERE n > 0;
SELECT tbl, col, n FROM (
  SELECT 'data_rooms' AS tbl, 'owner_id' AS col, count(*) AS n FROM data_rooms WHERE owner_id LIKE '%email:%@%'
  UNION ALL SELECT 'documents' AS tbl, 'app_id' AS col, count(*) AS n FROM documents WHERE app_id LIKE '%email:%@%'
  UNION ALL SELECT 'documents' AS tbl, 'collection' AS col, count(*) AS n FROM documents WHERE collection LIKE '%email:%@%'
  UNION ALL SELECT 'documents' AS tbl, 'id' AS col, count(*) AS n FROM documents WHERE id LIKE '%email:%@%'
  UNION ALL SELECT 'documents' AS tbl, 'data' AS col, count(*) AS n FROM documents WHERE data LIKE '%email:%@%'
) WHERE n > 0;
SELECT tbl, col, n FROM (
  SELECT 'documents' AS tbl, 'owner_id' AS col, count(*) AS n FROM documents WHERE owner_id LIKE '%email:%@%'
  UNION ALL SELECT 'documents' AS tbl, 'visibility' AS col, count(*) AS n FROM documents WHERE visibility LIKE '%email:%@%'
  UNION ALL SELECT 'error_log' AS tbl, 'source' AS col, count(*) AS n FROM error_log WHERE source LIKE '%email:%@%'
  UNION ALL SELECT 'error_log' AS tbl, 'user_github' AS col, count(*) AS n FROM error_log WHERE user_github LIKE '%email:%@%'
  UNION ALL SELECT 'error_log' AS tbl, 'context' AS col, count(*) AS n FROM error_log WHERE context LIKE '%email:%@%'
) WHERE n > 0;
SELECT tbl, col, n FROM (
  SELECT 'error_log' AS tbl, 'message' AS col, count(*) AS n FROM error_log WHERE message LIKE '%email:%@%'
  UNION ALL SELECT 'error_log' AS tbl, 'stack' AS col, count(*) AS n FROM error_log WHERE stack LIKE '%email:%@%'
  UNION ALL SELECT 'friendships' AS tbl, 'user_a' AS col, count(*) AS n FROM friendships WHERE user_a LIKE '%email:%@%'
  UNION ALL SELECT 'friendships' AS tbl, 'user_b' AS col, count(*) AS n FROM friendships WHERE user_b LIKE '%email:%@%'
  UNION ALL SELECT 'friendships' AS tbl, 'status' AS col, count(*) AS n FROM friendships WHERE status LIKE '%email:%@%'
) WHERE n > 0;
SELECT tbl, col, n FROM (
  SELECT 'friendships' AS tbl, 'initiator' AS col, count(*) AS n FROM friendships WHERE initiator LIKE '%email:%@%'
  UNION ALL SELECT 'friendships' AS tbl, 'blocker' AS col, count(*) AS n FROM friendships WHERE blocker LIKE '%email:%@%'
  UNION ALL SELECT 'health_checks' AS tbl, 'target' AS col, count(*) AS n FROM health_checks WHERE target LIKE '%email:%@%'
  UNION ALL SELECT 'health_checks' AS tbl, 'url' AS col, count(*) AS n FROM health_checks WHERE url LIKE '%email:%@%'
  UNION ALL SELECT 'health_checks' AS tbl, 'error' AS col, count(*) AS n FROM health_checks WHERE error LIKE '%email:%@%'
) WHERE n > 0;
SELECT tbl, col, n FROM (
  SELECT 'idea_builders' AS tbl, 'idea_id' AS col, count(*) AS n FROM idea_builders WHERE idea_id LIKE '%email:%@%'
  UNION ALL SELECT 'idea_builders' AS tbl, 'user_id' AS col, count(*) AS n FROM idea_builders WHERE user_id LIKE '%email:%@%'
  UNION ALL SELECT 'key_providers' AS tbl, 'id' AS col, count(*) AS n FROM key_providers WHERE id LIKE '%email:%@%'
  UNION ALL SELECT 'key_providers' AS tbl, 'name' AS col, count(*) AS n FROM key_providers WHERE name LIKE '%email:%@%'
  UNION ALL SELECT 'key_providers' AS tbl, 'docs_url' AS col, count(*) AS n FROM key_providers WHERE docs_url LIKE '%email:%@%'
) WHERE n > 0;
SELECT tbl, col, n FROM (
  SELECT 'key_providers' AS tbl, 'key_prefix' AS col, count(*) AS n FROM key_providers WHERE key_prefix LIKE '%email:%@%'
  UNION ALL SELECT 'kv' AS tbl, 'app_id' AS col, count(*) AS n FROM kv WHERE app_id LIKE '%email:%@%'
  UNION ALL SELECT 'kv' AS tbl, 'user_id' AS col, count(*) AS n FROM kv WHERE user_id LIKE '%email:%@%'
  UNION ALL SELECT 'kv' AS tbl, 'key' AS col, count(*) AS n FROM kv WHERE key LIKE '%email:%@%'
  UNION ALL SELECT 'kv' AS tbl, 'value' AS col, count(*) AS n FROM kv WHERE instr(value, CAST('email:' AS BLOB)) > 0 AND instr(value, CAST('@' AS BLOB)) > 0
) WHERE n > 0;
SELECT tbl, col, n FROM (
  SELECT 'push_schedules' AS tbl, 'id' AS col, count(*) AS n FROM push_schedules WHERE id LIKE '%email:%@%'
  UNION ALL SELECT 'push_schedules' AS tbl, 'app_id' AS col, count(*) AS n FROM push_schedules WHERE app_id LIKE '%email:%@%'
  UNION ALL SELECT 'push_schedules' AS tbl, 'user_id' AS col, count(*) AS n FROM push_schedules WHERE user_id LIKE '%email:%@%'
  UNION ALL SELECT 'push_schedules' AS tbl, 'reminder_id' AS col, count(*) AS n FROM push_schedules WHERE reminder_id LIKE '%email:%@%'
  UNION ALL SELECT 'push_schedules' AS tbl, 'rule' AS col, count(*) AS n FROM push_schedules WHERE rule LIKE '%email:%@%'
) WHERE n > 0;
SELECT tbl, col, n FROM (
  SELECT 'push_schedules' AS tbl, 'tz' AS col, count(*) AS n FROM push_schedules WHERE tz LIKE '%email:%@%'
  UNION ALL SELECT 'push_subscriptions' AS tbl, 'id' AS col, count(*) AS n FROM push_subscriptions WHERE id LIKE '%email:%@%'
  UNION ALL SELECT 'push_subscriptions' AS tbl, 'app_id' AS col, count(*) AS n FROM push_subscriptions WHERE app_id LIKE '%email:%@%'
  UNION ALL SELECT 'push_subscriptions' AS tbl, 'user_id' AS col, count(*) AS n FROM push_subscriptions WHERE user_id LIKE '%email:%@%'
  UNION ALL SELECT 'push_subscriptions' AS tbl, 'endpoint' AS col, count(*) AS n FROM push_subscriptions WHERE endpoint LIKE '%email:%@%'
) WHERE n > 0;
SELECT tbl, col, n FROM (
  SELECT 'push_subscriptions' AS tbl, 'p256dh' AS col, count(*) AS n FROM push_subscriptions WHERE p256dh LIKE '%email:%@%'
  UNION ALL SELECT 'push_subscriptions' AS tbl, 'auth' AS col, count(*) AS n FROM push_subscriptions WHERE auth LIKE '%email:%@%'
  UNION ALL SELECT 'push_subscriptions' AS tbl, 'user_agent' AS col, count(*) AS n FROM push_subscriptions WHERE user_agent LIKE '%email:%@%'
  UNION ALL SELECT 'user_api_keys' AS tbl, 'user_id' AS col, count(*) AS n FROM user_api_keys WHERE user_id LIKE '%email:%@%'
  UNION ALL SELECT 'user_api_keys' AS tbl, 'provider' AS col, count(*) AS n FROM user_api_keys WHERE provider LIKE '%email:%@%'
) WHERE n > 0;
SELECT tbl, col, n FROM (
  SELECT 'user_api_keys' AS tbl, 'label' AS col, count(*) AS n FROM user_api_keys WHERE label LIKE '%email:%@%'
  UNION ALL SELECT 'user_api_keys' AS tbl, 'provisioned_by' AS col, count(*) AS n FROM user_api_keys WHERE provisioned_by LIKE '%email:%@%'
  UNION ALL SELECT 'users' AS tbl, 'id' AS col, count(*) AS n FROM users WHERE id LIKE '%email:%@%'
  UNION ALL SELECT 'users' AS tbl, 'github_login' AS col, count(*) AS n FROM users WHERE github_login LIKE '%email:%@%'
  UNION ALL SELECT 'users' AS tbl, 'avatar_url' AS col, count(*) AS n FROM users WHERE avatar_url LIKE '%email:%@%'
) WHERE n > 0;
SELECT tbl, col, n FROM (
  SELECT 'users' AS tbl, 'provider' AS col, count(*) AS n FROM users WHERE provider LIKE '%email:%@%'
  UNION ALL SELECT 'users' AS tbl, 'provider_id' AS col, count(*) AS n FROM users WHERE provider_id LIKE '%email:%@%'
  UNION ALL SELECT 'users' AS tbl, 'email' AS col, count(*) AS n FROM users WHERE email LIKE '%email:%@%'
  UNION ALL SELECT 'users' AS tbl, 'display_name' AS col, count(*) AS n FROM users WHERE display_name LIKE '%email:%@%'
  UNION ALL SELECT 'users' AS tbl, 'date_of_birth' AS col, count(*) AS n FROM users WHERE date_of_birth LIKE '%email:%@%'
) WHERE n > 0;
SELECT tbl, col, n FROM (
  SELECT 'webhook_deliveries' AS tbl, 'id' AS col, count(*) AS n FROM webhook_deliveries WHERE id LIKE '%email:%@%'
  UNION ALL SELECT 'webhook_deliveries' AS tbl, 'webhook_id' AS col, count(*) AS n FROM webhook_deliveries WHERE webhook_id LIKE '%email:%@%'
  UNION ALL SELECT 'webhook_deliveries' AS tbl, 'event' AS col, count(*) AS n FROM webhook_deliveries WHERE event LIKE '%email:%@%'
  UNION ALL SELECT 'webhook_deliveries' AS tbl, 'payload' AS col, count(*) AS n FROM webhook_deliveries WHERE payload LIKE '%email:%@%'
) WHERE n > 0;
