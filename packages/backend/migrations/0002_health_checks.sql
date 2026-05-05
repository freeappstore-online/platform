-- Per-target uptime check log. Cron writes one row per check.
-- We keep the last 30 days (uptime cron also evicts older rows).
CREATE TABLE IF NOT EXISTS health_checks (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  target       TEXT NOT NULL,         -- "<app-id>" or "<arbitrary-label>"
  url          TEXT NOT NULL,
  ok           INTEGER NOT NULL,      -- 1 = passed, 0 = failed
  status       INTEGER,               -- HTTP status (null on connect error)
  duration_ms  INTEGER NOT NULL,
  error        TEXT,                  -- error message on failure
  checked_at   INTEGER NOT NULL       -- ms since epoch
);

CREATE INDEX IF NOT EXISTS health_checks_target_idx
  ON health_checks (target, checked_at DESC);

CREATE INDEX IF NOT EXISTS health_checks_at_idx
  ON health_checks (checked_at);
