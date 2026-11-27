-- Paired devices (#833, #845). Each device reports its app version label
-- ("0.4.0 (57, abc1234)") and client kind (android, ios, desktop) in headers;
-- the last seen values are kept here, written only when they change or every
-- 15 minutes, so the console's device list can show them.
ALTER TABLE native_devices ADD COLUMN app_version TEXT;
ALTER TABLE native_devices ADD COLUMN client TEXT;
ALTER TABLE native_devices ADD COLUMN last_seen_at INTEGER;

-- QR pairing (#845): a signed-in console or device shows a short-lived code,
-- a phone redeems it once for its own device credential. Only the code's
-- SHA-256 is stored. A row stays 30 days after it expires as the record of
-- who made it, from where, and which device it paired.
CREATE TABLE native_pair_codes (
  code_hash TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  created_by TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  used_at INTEGER,
  device_id TEXT
);
CREATE INDEX native_pair_codes_user ON native_pair_codes(user_id);
CREATE INDEX native_pair_codes_expiry ON native_pair_codes(expires_at);
