-- Per-app visitor analytics config. Read by the public /v1/analytics.js
-- loader script that each FreeAppStore (and FreeGameStore-mirror) app
-- embeds in its <head>. Written by the owner via PUT /v1/apps/:id/analytics.
--
-- cf_beacon_token is auto-provisioned at publish time by the admin Worker
-- (Cloudflare Web Analytics — cookieless, no PII). The remaining fields
-- are opt-in BYO tags the owner sets later: GA4 measurement ID, Plausible
-- domain, or a free-form <head> snippet (capped at 4 KB so a runaway value
-- can't blow up every page on the app).

CREATE TABLE IF NOT EXISTS app_analytics (
  app_id            TEXT PRIMARY KEY,
  cf_beacon_token   TEXT,                  -- Cloudflare Web Analytics site token
  ga4               TEXT,                  -- G-XXXXXXXXXX
  plausible         TEXT,                  -- e.g. "mysite.com" (loads from plausible.io)
  custom_head       TEXT,                  -- free-form <head> snippet (<=4 KB)
  updated_at        INTEGER NOT NULL
);
