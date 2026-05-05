-- Users known to the platform. We key on GitHub user id so multiple apps
-- see the same user identity without each app holding its own auth state.
CREATE TABLE IF NOT EXISTS users (
  id              TEXT PRIMARY KEY,           -- internal id, e.g. "gh:12345"
  github_id       INTEGER NOT NULL UNIQUE,
  github_login    TEXT NOT NULL,
  avatar_url      TEXT,
  created_at      INTEGER NOT NULL
);

-- Per-user, per-app key-value store.
-- (app_id, user_id, key) is the natural primary key.
-- value_size_bytes is denormalized so we can enforce the 1MB-per-user cap
-- with a single SUM() lookup at write time.
CREATE TABLE IF NOT EXISTS kv (
  app_id            TEXT NOT NULL,
  user_id           TEXT NOT NULL,
  key               TEXT NOT NULL,
  value             BLOB NOT NULL,
  value_size_bytes  INTEGER NOT NULL,
  updated_at        INTEGER NOT NULL,
  PRIMARY KEY (app_id, user_id, key)
);

CREATE INDEX IF NOT EXISTS kv_user_idx ON kv (app_id, user_id);

-- Apps registered on the platform. Mirrors the registry in the storefront repo
-- but is the auth-time source of truth for "is this a real app id?".
CREATE TABLE IF NOT EXISTS apps (
  id           TEXT PRIMARY KEY,
  owner_login  TEXT NOT NULL,
  created_at   INTEGER NOT NULL
);
