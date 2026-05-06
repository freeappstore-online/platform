-- Per-app audit results from the weekly compliance audit Worker. One row
-- per (app_id, check_name) pair, replaced on every audit run. Lets the
-- storefront / dashboards show "this app failed brand-fonts on the last
-- audit" without re-running checks at request time.
CREATE TABLE IF NOT EXISTS audit_results (
  app_id        TEXT NOT NULL,
  store         TEXT NOT NULL,        -- 'apps' | 'games'
  check_name    TEXT NOT NULL,
  status        TEXT NOT NULL,        -- 'pass' | 'warn' | 'fail'
  detail        TEXT,
  checked_at    INTEGER NOT NULL,
  PRIMARY KEY (app_id, check_name)
);

CREATE INDEX IF NOT EXISTS audit_results_store_idx ON audit_results (store, status);
CREATE INDEX IF NOT EXISTS audit_results_checked_at_idx ON audit_results (checked_at);
