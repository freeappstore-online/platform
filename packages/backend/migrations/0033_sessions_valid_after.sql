-- #495: server-side session revocation. POST /v1/auth/logout sets this to
-- the current epoch second; requireUser rejects any session whose iat is
-- older. Zero rows to maintain — the users row is already read per request.
ALTER TABLE users ADD COLUMN sessions_valid_after INTEGER NOT NULL DEFAULT 0;
