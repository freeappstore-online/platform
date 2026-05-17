-- Fix github_id unique constraint for multi-provider auth.
CREATE TABLE IF NOT EXISTS _migration_noop_0009 (id INTEGER PRIMARY KEY);
DROP TABLE IF EXISTS _migration_noop_0009;
