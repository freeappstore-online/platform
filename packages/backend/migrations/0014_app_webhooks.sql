-- Outbound webhooks: devs register URLs to receive HTTP POST on events.
-- Vendored from PAS (0013 + 0014), combined into one migration.

CREATE TABLE IF NOT EXISTS app_webhooks (
  id TEXT PRIMARY KEY,
  app_id TEXT NOT NULL,
  event TEXT NOT NULL,
  url TEXT NOT NULL,
  secret TEXT NOT NULL,
  active INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL DEFAULT (unixepoch())
);
CREATE INDEX IF NOT EXISTS idx_app_webhooks_app_event ON app_webhooks (app_id, event);

CREATE TABLE IF NOT EXISTS webhook_deliveries (
  id TEXT PRIMARY KEY,
  webhook_id TEXT NOT NULL,
  event TEXT NOT NULL,
  payload TEXT NOT NULL,
  status INTEGER,
  attempts INTEGER NOT NULL DEFAULT 0,
  last_attempt_at INTEGER,
  created_at INTEGER NOT NULL DEFAULT (unixepoch())
);
CREATE INDEX IF NOT EXISTS idx_webhook_deliveries_webhook ON webhook_deliveries (webhook_id, created_at);
