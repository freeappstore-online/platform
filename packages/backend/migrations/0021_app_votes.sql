-- Store-level app votes. One vote per platform user per app.
-- This is a platform primitive, not an app-developer counter.
-- PRIMARY KEY (app_id, user_id) enforces the one-vote-per-user rule at the DB layer.

CREATE TABLE IF NOT EXISTS app_votes (
  app_id     TEXT    NOT NULL,
  user_id    TEXT    NOT NULL,
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  PRIMARY KEY (app_id, user_id)
);

CREATE INDEX IF NOT EXISTS idx_app_votes_app  ON app_votes (app_id);
CREATE INDEX IF NOT EXISTS idx_app_votes_user ON app_votes (user_id);
