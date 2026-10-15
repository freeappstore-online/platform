-- Web Push subscriptions for `fas.push` (#145): one row per browser/device
-- registration, scoped to (app_id, user_id) like kv.
--
-- endpoint is the push service URL the browser hands out. It is globally
-- unique to one browser registration, so it is the upsert key: re-subscribing
-- the same device updates the row, and a device that changes hands (a
-- different user signs in on it, or the endpoint is re-registered for another
-- app) moves rather than duplicates. p256dh/auth are the subscription's
-- public encryption keys (base64url), needed only for encrypted payloads.
--
-- The VAPID key pair that signs pushes is one platform secret, not stored
-- here. last_success_at / failure_count are for the sender: it records
-- deliveries and prunes endpoints the push service has expired.

CREATE TABLE IF NOT EXISTS push_subscriptions (
  id              TEXT    PRIMARY KEY,
  app_id          TEXT    NOT NULL,
  user_id         TEXT    NOT NULL,
  endpoint        TEXT    NOT NULL UNIQUE,
  p256dh          TEXT    NOT NULL,
  auth            TEXT    NOT NULL,
  user_agent      TEXT,
  created_at      INTEGER NOT NULL,
  last_success_at INTEGER,
  failure_count   INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_push_subscriptions_app_user ON push_subscriptions (app_id, user_id);
CREATE INDEX IF NOT EXISTS idx_push_subscriptions_user     ON push_subscriptions (user_id);
