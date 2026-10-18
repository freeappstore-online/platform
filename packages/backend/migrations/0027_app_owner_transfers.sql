-- Audit trail for admin app-ownership transfers (#274).
-- One row per successful compare-and-set. from_login is the owner at the
-- moment of the transfer; actor_login is the admin who ran it.

CREATE TABLE IF NOT EXISTS app_owner_transfers (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  app_id      TEXT NOT NULL,
  from_login  TEXT NOT NULL,
  to_login    TEXT NOT NULL,
  reason      TEXT NOT NULL,
  actor_login TEXT NOT NULL,
  created_at  INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS app_owner_transfers_app_idx ON app_owner_transfers (app_id, id);
