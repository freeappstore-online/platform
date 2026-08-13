-- Platform error log: handler-level exceptions written by backend routes.
-- Enables diagnosing silent failures that leave no other trace.
--
-- source      — route identifier, e.g. 'GET /agent/sessions'
-- user_github — GitHub login of the authenticated user at time of error (nullable for unauthenticated paths)
-- context     — JSON blob with request-level metadata (status, path, etc.)
-- message     — error.message
-- stack       — error.stack (truncated at 4000 chars to avoid D1 TEXT limits)

CREATE TABLE IF NOT EXISTS error_log (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  ts          INTEGER NOT NULL,
  source      TEXT    NOT NULL,
  user_github TEXT,
  context     TEXT,
  message     TEXT    NOT NULL,
  stack       TEXT
);

CREATE INDEX IF NOT EXISTS idx_error_log_ts ON error_log (ts DESC);
CREATE INDEX IF NOT EXISTS idx_error_log_source ON error_log (source, ts DESC);
