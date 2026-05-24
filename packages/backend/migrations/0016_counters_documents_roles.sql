-- Missing tables for SDK features: counters, collections (documents), app roles.
-- These route handlers existed but the tables were never created.

-- Shared atomic counters per app (votes, views, leaderboard scores).
CREATE TABLE IF NOT EXISTS counters (
  app_id      TEXT NOT NULL,
  key         TEXT NOT NULL,
  value       INTEGER NOT NULL DEFAULT 0,
  updated_at  INTEGER NOT NULL,
  PRIMARY KEY (app_id, key)
);

-- Firestore-style document collections per app.
CREATE TABLE IF NOT EXISTS documents (
  app_id      TEXT NOT NULL,
  collection  TEXT NOT NULL,
  id          TEXT NOT NULL,
  data        TEXT NOT NULL,             -- JSON object
  owner_id    TEXT NOT NULL,             -- user who created this doc
  visibility  TEXT NOT NULL DEFAULT 'public',
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL,
  PRIMARY KEY (app_id, collection, id)
);

CREATE INDEX IF NOT EXISTS idx_documents_owner ON documents (app_id, collection, owner_id);

-- Per-app role assignments (RBAC).
CREATE TABLE IF NOT EXISTS app_roles (
  app_id      TEXT NOT NULL,
  user_id     TEXT NOT NULL,
  role_name   TEXT NOT NULL,
  granted_by  TEXT,                      -- user_id of who granted, NULL if system
  granted_at  INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
  PRIMARY KEY (app_id, user_id, role_name)
);

CREATE INDEX IF NOT EXISTS idx_app_roles_user ON app_roles (user_id);
