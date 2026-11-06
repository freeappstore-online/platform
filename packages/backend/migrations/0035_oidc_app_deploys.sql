-- Keyless app deploys (#460, #523): routes/deploy.ts.
--
-- app_repositories pins each app to one GitHub repository by its immutable
-- repository_id, so a renamed, deleted-and-recreated or reused repo name can
-- never deploy to the app. UNIQUE(repository_id) maps a repo to exactly one app.
CREATE TABLE IF NOT EXISTS app_repositories (
  app_id        TEXT PRIMARY KEY,
  repository_id TEXT NOT NULL UNIQUE,
  repository    TEXT NOT NULL,
  pinned_at     INTEGER NOT NULL
);

-- One row per deploy session. jti is UNIQUE so an OIDC token opens one session
-- at most (replay protection); token_hash is the SHA-256 of the upload token.
-- status: open -> live -> superseded -> deleted (or open past expires_at).
CREATE TABLE IF NOT EXISTS app_deploys (
  id            TEXT PRIMARY KEY,
  app_id        TEXT NOT NULL,
  jti           TEXT NOT NULL UNIQUE,
  repository_id TEXT NOT NULL,
  sha           TEXT,
  run_id        TEXT,
  token_hash    TEXT NOT NULL,
  manifest      TEXT NOT NULL,
  total_bytes   INTEGER NOT NULL,
  status        TEXT NOT NULL,
  created_at    INTEGER NOT NULL,
  expires_at    INTEGER NOT NULL,
  committed_at  INTEGER
);
CREATE INDEX IF NOT EXISTS app_deploys_app_created ON app_deploys (app_id, created_at);
