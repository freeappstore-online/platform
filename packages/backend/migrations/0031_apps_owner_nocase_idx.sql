-- Owner lookups compare case-insensitively (GitHub logins are), as
-- `WHERE owner_login = ? COLLATE NOCASE`. SQLite can't serve that from the
-- BINARY apps_owner_idx (0003), so each one was a full scan of apps (#442).
CREATE INDEX IF NOT EXISTS apps_owner_nocase_idx ON apps (owner_login COLLATE NOCASE);
