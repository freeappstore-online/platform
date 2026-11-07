-- Per-app override of the keyless deploy limits (#544). Admin-set; an app with
-- no row (or a NULL column) keeps the defaults in routes/deploy.ts.
CREATE TABLE IF NOT EXISTS app_deploy_limits (
  app_id          TEXT PRIMARY KEY,
  max_files       INTEGER,
  max_total_bytes INTEGER,
  max_file_bytes  INTEGER,
  set_by          TEXT NOT NULL,
  set_at          INTEGER NOT NULL
);

-- scoreplay: 13,235 files, 770 MiB, one 42 MiB PDF (the Mutopia catalogue).
-- Caps leave headroom for catalogue growth; the Worker request body limit is
-- 100 MB, so no single file may exceed 90 MiB.
INSERT OR IGNORE INTO app_deploy_limits (app_id, max_files, max_total_bytes, max_file_bytes, set_by, set_at)
VALUES ('scoreplay', 20000, 1610612736, 94371840, 'migration 0040 (#544)', CAST(strftime('%s', 'now') AS INTEGER) * 1000);
