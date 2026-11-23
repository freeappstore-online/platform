-- FAS native companion (#616): a phone app that keeps collecting location with
-- the screen locked and hands it to the FAS apps its user enables. Vendored from
-- the PAS protocol (proappstore-online/platform ADR-015/016).
--
-- Consumer devices have their own narrow, revocable credential; no FAS session
-- is stored here. FAS tables reference users/apps by convention, not FOREIGN KEY
-- (account deletion clears native_devices explicitly in DELETE /v1/auth/me; a
-- grant only counts while apps.owner_id still equals its publisher_id). Within
-- these tables the cascades carry revocation: device -> grants -> points.
CREATE TABLE native_devices (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  label TEXT NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE INDEX native_devices_user ON native_devices(user_id);

CREATE TABLE native_pairings (
  id TEXT PRIMARY KEY,
  challenge TEXT NOT NULL,
  label TEXT NOT NULL,
  user_id TEXT,
  browser_hash TEXT,
  approved INTEGER NOT NULL DEFAULT 0 CHECK(approved IN (0,1)),
  expires_at INTEGER NOT NULL
);

CREATE TABLE native_grants (
  id TEXT PRIMARY KEY,
  device_id TEXT NOT NULL REFERENCES native_devices(id) ON DELETE CASCADE,
  app_id TEXT NOT NULL,
  publisher_id TEXT NOT NULL,
  capability TEXT NOT NULL CHECK(capability = 'location.background'),
  contract_version TEXT NOT NULL,
  consent_at INTEGER NOT NULL,
  UNIQUE(device_id, app_id, capability)
);
CREATE INDEX native_grants_app ON native_grants(app_id);

CREATE TABLE native_locations (
  grant_id TEXT NOT NULL REFERENCES native_grants(id) ON DELETE CASCADE,
  point_id TEXT NOT NULL,
  recorded_at INTEGER NOT NULL,
  latitude REAL NOT NULL CHECK(latitude BETWEEN -90 AND 90),
  longitude REAL NOT NULL CHECK(longitude BETWEEN -180 AND 180),
  accuracy REAL NOT NULL CHECK(accuracy >= 0),
  PRIMARY KEY(grant_id, point_id)
);
CREATE INDEX native_locations_time ON native_locations(recorded_at);
CREATE INDEX native_locations_grant_time ON native_locations(grant_id, recorded_at, point_id);

-- Irreversible revocations, not filters that could resurrect consent if the
-- owner were later changed back.
CREATE TRIGGER native_revoke_on_owner_change
AFTER UPDATE OF owner_id ON apps WHEN OLD.owner_id IS NOT NEW.owner_id
BEGIN
  DELETE FROM native_grants WHERE app_id = NEW.id;
END;
CREATE TRIGGER native_revoke_on_app_delete
AFTER DELETE ON apps
BEGIN
  DELETE FROM native_grants WHERE app_id = OLD.id;
END;
