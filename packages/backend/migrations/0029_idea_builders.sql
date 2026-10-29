-- "I'm building this" claims on the storefront's App ideas page
-- (freeappstore.online/ideas). One claim per platform user per idea; ideas
-- live in the storefront's data, so idea_id is not a foreign key.
-- Only claims made in the last 90 days count as active.

CREATE TABLE IF NOT EXISTS idea_builders (
  idea_id    TEXT    NOT NULL,
  user_id    TEXT    NOT NULL,
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  PRIMARY KEY (idea_id, user_id)
);

CREATE INDEX IF NOT EXISTS idx_idea_builders_user ON idea_builders (user_id, created_at);
CREATE INDEX IF NOT EXISTS idx_idea_builders_created ON idea_builders (created_at);
