-- AI usage observability for VibeCode (#16).

-- What each session used and who paid for it. The agent writes these on every
-- D1 sync. ai_source is where the latest turn's key came from:
-- 'vault_user' (the user's own vault key), 'vault_admin' (a key an admin
-- provisioned for them), 'grant' (platform-funded complimentary grant),
-- 'grant_unfunded' (a grant with no platform key behind it), 'browser_key'
-- (sent by the client), or 'none'. Never a key value.
ALTER TABLE agent_sessions ADD COLUMN input_tokens INTEGER NOT NULL DEFAULT 0;
ALTER TABLE agent_sessions ADD COLUMN output_tokens INTEGER NOT NULL DEFAULT 0;
ALTER TABLE agent_sessions ADD COLUMN ai_provider TEXT;
ALTER TABLE agent_sessions ADD COLUMN ai_model TEXT;
ALTER TABLE agent_sessions ADD COLUMN ai_source TEXT;
CREATE INDEX IF NOT EXISTS idx_agent_sessions_ai_source ON agent_sessions (ai_source, updated_at DESC);

-- Who put a key in a user's vault: NULL = the user themselves; otherwise the
-- admin (or 'admin-worker') who provisioned it. A user re-saving the key
-- resets it to NULL.
ALTER TABLE user_api_keys ADD COLUMN provisioned_by TEXT;

-- complimentary_grants was only ever created lazily by routes/keys.ts, so a
-- fresh database may not have it yet. Same shape as that CREATE.
CREATE TABLE IF NOT EXISTS complimentary_grants (
  user_id TEXT PRIMARY KEY,
  provider TEXT NOT NULL,
  model TEXT NOT NULL,
  granted_by TEXT NOT NULL,
  note TEXT,
  created_at INTEGER NOT NULL,
  expires_at TEXT
);
-- Stamped each time the grant funds a VibeCode turn. Token totals are summed
-- from the agent_sessions it funded (ai_source = 'grant'), not cached here.
ALTER TABLE complimentary_grants ADD COLUMN last_used_at INTEGER;
