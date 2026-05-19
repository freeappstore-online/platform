-- Email magic-link auth: index on users.email for fast lookup during
-- the callback's INSERT...ON CONFLICT. The column itself already exists
-- (added in 0008 for Google OAuth).
CREATE INDEX IF NOT EXISTS idx_users_email ON users(email);
