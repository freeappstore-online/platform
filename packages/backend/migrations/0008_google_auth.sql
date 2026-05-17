-- Support multiple auth providers (Google, GitHub, future).
-- Existing GitHub users keep working: github_id + github_login remain populated.
-- New columns are nullable for backwards compat with existing rows.

ALTER TABLE users ADD COLUMN provider TEXT;
ALTER TABLE users ADD COLUMN provider_id TEXT;
ALTER TABLE users ADD COLUMN email TEXT;
ALTER TABLE users ADD COLUMN display_name TEXT;

-- Backfill existing GitHub users
UPDATE users SET provider = 'github', provider_id = CAST(github_id AS TEXT), display_name = github_login;

-- Index for provider-based lookups
CREATE INDEX IF NOT EXISTS idx_users_provider ON users (provider, provider_id);
