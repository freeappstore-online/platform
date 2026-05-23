-- App logs: client-side log entries uploaded by the SDK logger.
-- Queried by app owners via /v1/apps/:appId/logs and by the MCP debug tool.

CREATE TABLE IF NOT EXISTS app_logs (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  app_id      TEXT    NOT NULL,
  user_id     TEXT    NOT NULL,
  ts          INTEGER NOT NULL,  -- client-side timestamp (ms since epoch)
  level       TEXT    NOT NULL,  -- debug, info, warn, error
  category    TEXT    NOT NULL DEFAULT 'app',  -- app, sdk, uncaught, promise
  message     TEXT    NOT NULL,
  data        TEXT,              -- JSON stringified extra data
  build_meta  TEXT,              -- JSON build metadata (version, commit, etc.)
  ingested_at INTEGER NOT NULL   -- server-side timestamp (ms since epoch)
);

CREATE INDEX IF NOT EXISTS idx_app_logs_app_ts ON app_logs (app_id, ts DESC);
CREATE INDEX IF NOT EXISTS idx_app_logs_app_level ON app_logs (app_id, level);

-- Auto-prune logs older than 7 days (run via scheduled cron or manual cleanup)
-- DELETE FROM app_logs WHERE ingested_at < (unixepoch() * 1000 - 7 * 86400000);
