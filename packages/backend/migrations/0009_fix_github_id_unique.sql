-- The github_id UNIQUE constraint prevents multiple Google users from signing up
-- (all Google users get github_id=0 which violates the constraint).
-- SQLite doesn't support DROP CONSTRAINT, so we rebuild the table without it.

CREATE TABLE IF NOT EXISTS users_new (
  id              TEXT PRIMARY KEY,
  github_id       INTEGER NOT NULL DEFAULT 0,
  github_login    TEXT NOT NULL,
  avatar_url      TEXT,
  created_at      INTEGER NOT NULL,
  provider        TEXT,
  provider_id     TEXT,
  email           TEXT,
  display_name    TEXT
);

INSERT INTO users_new SELECT id, github_id, github_login, avatar_url, created_at, provider, provider_id, email, display_name FROM users;

DROP TABLE users;

ALTER TABLE users_new RENAME TO users;

-- Re-create the provider index (the github_id unique index is intentionally gone)
CREATE INDEX IF NOT EXISTS idx_users_provider ON users (provider, provider_id);
