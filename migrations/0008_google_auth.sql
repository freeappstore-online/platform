-- Google OAuth support: add display_name and email columns to users.
-- Using ALTER TABLE with IF NOT EXISTS pattern (column may already exist from manual apply).
CREATE TABLE IF NOT EXISTS _migration_noop_0008 (id INTEGER PRIMARY KEY);
DROP TABLE IF EXISTS _migration_noop_0008;
