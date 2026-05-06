-- Extend apps with the metadata captured at publish time so /v1/apps/mine
-- can return useful per-user listings without round-tripping to the admin
-- worker or the GitHub-hosted registry.json on every call.
--
-- All new columns are nullable so existing rows (none in prod yet, but
-- keeping the migration safe-by-default) don't fail the ALTER.
ALTER TABLE apps ADD COLUMN category TEXT;
ALTER TABLE apps ADD COLUMN type TEXT;          -- 'standalone' | 'connected'
ALTER TABLE apps ADD COLUMN oneliner TEXT;
ALTER TABLE apps ADD COLUMN repo TEXT;          -- 'owner/name' on github
ALTER TABLE apps ADD COLUMN demo TEXT;

-- Index for the /v1/apps/mine hot path. Lists are typically short (<10
-- per user) but the index keeps the query O(log n) regardless.
CREATE INDEX IF NOT EXISTS apps_owner_idx ON apps (owner_login);
