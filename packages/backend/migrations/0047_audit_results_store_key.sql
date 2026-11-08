-- audit_results is keyed (app_id, store, check_name): an app id used in both
-- stores kept only one store's results, because the primary key lacked store.
CREATE TABLE audit_results_new (
  app_id        TEXT NOT NULL,
  store         TEXT NOT NULL,        -- 'apps' | 'games'
  check_name    TEXT NOT NULL,
  status        TEXT NOT NULL,        -- 'pass' | 'warn' | 'fail'
  detail        TEXT,
  checked_at    INTEGER NOT NULL,
  PRIMARY KEY (app_id, store, check_name)
);
INSERT INTO audit_results_new SELECT app_id, store, check_name, status, detail, checked_at FROM audit_results;
DROP TABLE audit_results;
ALTER TABLE audit_results_new RENAME TO audit_results;
CREATE INDEX IF NOT EXISTS audit_results_store_idx ON audit_results (store, status);
CREATE INDEX IF NOT EXISTS audit_results_checked_at_idx ON audit_results (checked_at);
