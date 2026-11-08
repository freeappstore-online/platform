-- Who owned an app whose repo was archived by an unpublish (#575). The apps row
-- is gone by then, and the archived repo still blocks the id, so without this
-- the original owner could never publish it again. Removed when the id is
-- claimed again, or when the unpublish deletes the repo.
CREATE TABLE IF NOT EXISTS unpublished_apps (
  id             TEXT PRIMARY KEY,
  owner_id       TEXT,
  owner_login    TEXT NOT NULL,
  unpublished_at INTEGER NOT NULL
);
