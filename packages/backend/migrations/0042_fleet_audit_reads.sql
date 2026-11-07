-- One row per accepted read of GET /v1/audit/apps (#552). The endpoint is
-- authenticated by a GitHub Actions OIDC token only, and counts these rows to
-- allow a small number of reads per hour, so a leaked token cannot be used to
-- scrape. Holds no token and no caller data.
CREATE TABLE IF NOT EXISTS fleet_audit_reads (
  id      INTEGER PRIMARY KEY AUTOINCREMENT,
  read_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS fleet_audit_reads_at ON fleet_audit_reads (read_at);
