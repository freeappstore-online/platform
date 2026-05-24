-- VibeCode agent sessions: projects + chat messages persisted in D1.
-- Replaces localStorage (per-device, lost on clear) and DO SQLite (evicts after 24h).

CREATE TABLE IF NOT EXISTS agent_sessions (
  session_id  TEXT PRIMARY KEY,
  user_id     TEXT NOT NULL,
  name        TEXT NOT NULL DEFAULT 'New App',
  app_id      TEXT,               -- set after deploy
  app_url     TEXT,               -- preview URL
  deployed    INTEGER NOT NULL DEFAULT 0,
  messages    TEXT,               -- JSON array of chat messages
  deploy_state TEXT,              -- JSON deploy status
  created_at  INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
  updated_at  INTEGER NOT NULL DEFAULT (unixepoch() * 1000)
);

CREATE INDEX IF NOT EXISTS idx_agent_sessions_user ON agent_sessions (user_id, updated_at DESC);
