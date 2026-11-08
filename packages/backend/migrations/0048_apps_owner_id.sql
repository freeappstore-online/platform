-- Immutable app owner (#566). apps.owner_login is a GitHub username: mutable,
-- and re-registrable by someone else after a rename. Ownership is now decided
-- on apps.owner_id, the owner's `gh:<numeric GitHub id>` (users.id); owner_login
-- stays for display.
ALTER TABLE apps ADD COLUMN owner_id TEXT;

-- Backfill FAS rows from users by the current login. Only when exactly one
-- GitHub account carries that login (sign-in rewrites github_login, so a stale
-- duplicate must not be guessed at). Rows left NULL are bound by the owner's
-- next GitHub sign-in (computeRoles) and are owned by nobody until then.
UPDATE apps
   SET owner_id = (
     SELECT u.id FROM users u
      WHERE u.id LIKE 'gh:%' AND lower(u.github_login) = lower(apps.owner_login)
   )
 WHERE owner_id IS NULL
   AND (store IS NULL OR store = 'apps')
   AND (
     SELECT count(*) FROM users u
      WHERE u.id LIKE 'gh:%' AND lower(u.github_login) = lower(apps.owner_login)
   ) = 1;

CREATE INDEX IF NOT EXISTS apps_owner_id_idx ON apps (owner_id);
