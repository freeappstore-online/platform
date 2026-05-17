-- Shared (not user-scoped) atomic counters per app.
-- Used for: vote tallies, view counts, leaderboard scores.
CREATE TABLE IF NOT EXISTS counters (
  app_id TEXT NOT NULL,
  key TEXT NOT NULL,
  value INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (app_id, key)
);

CREATE INDEX IF NOT EXISTS idx_counters_app ON counters(app_id);
