-- App-secret proxy: lets free FAS apps safely call third-party APIs that
-- need an API key. Three tables:
--
--   app_secrets         envelope-encrypted developer-supplied keys
--   app_proxy_allowlist per-app allowed upstream URL patterns + injection rules
--   app_proxy_usage     per-app daily request counter (probabilistic writes)
--
-- See docs/APP-SECRET-PROXY.md for the full spec.

-- Encrypted developer-supplied API keys.
-- key_ciphertext is AES-256-GCM ciphertext of the raw API key.
-- dek_wrapped is the per-row data-encryption-key, itself AES-256-GCM-
-- encrypted under the master KEK in env.APP_SECRET_KEK. Envelope encryption
-- means rotating the KEK only requires re-wrapping each row's DEK (cheap),
-- not re-encrypting every key.
CREATE TABLE IF NOT EXISTS app_secrets (
  app_id          TEXT NOT NULL,
  name            TEXT NOT NULL,        -- e.g. 'OPENWEATHER_KEY'
  key_ciphertext  BLOB NOT NULL,
  dek_wrapped     BLOB NOT NULL,
  iv              BLOB NOT NULL,        -- 12-byte IV for the key-ciphertext encryption
  created_at      INTEGER NOT NULL,
  last_used_at    INTEGER,              -- updated probabilistically (1-in-10) to save D1 writes
  PRIMARY KEY (app_id, name)
);

-- Per-app allowed upstream URL patterns + injection rules. The proxy
-- refuses any request whose target URL doesn't match a pattern here.
-- pattern is a URL prefix (no globs). methods is a comma-separated list
-- of allowed HTTP verbs.
CREATE TABLE IF NOT EXISTS app_proxy_allowlist (
  app_id        TEXT NOT NULL,
  pattern       TEXT NOT NULL,          -- e.g. 'https://api.openweathermap.org/data/2.5/'
  inject_kind   TEXT NOT NULL,          -- 'query' | 'header' | 'bearer'
  inject_name   TEXT NOT NULL,          -- 'appid' (query), 'X-API-Key' (header). Ignored for 'bearer'.
  secret_name   TEXT NOT NULL,          -- references app_secrets.name
  methods       TEXT NOT NULL,          -- comma-separated, e.g. 'GET,POST'
  created_at    INTEGER NOT NULL,
  PRIMARY KEY (app_id, pattern)
);

CREATE INDEX IF NOT EXISTS app_proxy_allowlist_app_idx ON app_proxy_allowlist (app_id);

-- Per-app daily request counter. Writes are probabilistic (1-in-10) —
-- each proxy call increments by 10 with 10% probability. Keeps D1
-- writes inside the free tier (100k/day) at moderate scale; expected
-- count is unbiased.
CREATE TABLE IF NOT EXISTS app_proxy_usage (
  app_id        TEXT NOT NULL,
  day           TEXT NOT NULL,          -- 'YYYY-MM-DD' UTC
  count         INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (app_id, day)
);
