-- User API Key Vault: encrypted per-user API keys for third-party services.
-- Keys are stored using envelope encryption (same as app_secrets) and are
-- injected server-side by the proxy. Apps never see the plaintext key.

CREATE TABLE IF NOT EXISTS user_api_keys (
  user_id        TEXT    NOT NULL,
  provider       TEXT    NOT NULL,  -- e.g. 'openai', 'anthropic', 'stripe'
  label          TEXT,              -- user-friendly label, e.g. 'My OpenAI key'
  key_ciphertext BLOB    NOT NULL,
  dek_wrapped    BLOB    NOT NULL,
  iv             BLOB    NOT NULL,
  created_at     INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
  last_used_at   INTEGER,
  PRIMARY KEY (user_id, provider)
);

-- Supported providers registry. Platform-managed, not user-editable.
-- Apps declare which providers they need; the platform page shows the
-- user which keys are missing for their installed apps.
CREATE TABLE IF NOT EXISTS key_providers (
  id          TEXT PRIMARY KEY,  -- e.g. 'openai'
  name        TEXT NOT NULL,     -- e.g. 'OpenAI'
  docs_url    TEXT,              -- Link to the provider's API key page
  key_prefix  TEXT,              -- Expected prefix for validation, e.g. 'sk-'
  created_at  INTEGER NOT NULL DEFAULT (unixepoch() * 1000)
);

-- Seed common providers
INSERT OR IGNORE INTO key_providers (id, name, docs_url, key_prefix) VALUES
  ('openai',     'OpenAI',       'https://platform.openai.com/api-keys', 'sk-'),
  ('anthropic',  'Anthropic',    'https://console.anthropic.com/settings/keys', 'sk-ant-'),
  ('google-ai',  'Google AI',    'https://aistudio.google.com/apikey', 'AI'),
  ('openrouter', 'OpenRouter',   'https://openrouter.ai/settings/keys', 'sk-or-'),
  ('replicate',  'Replicate',    'https://replicate.com/account/api-tokens', 'r8_'),
  ('stability',  'Stability AI', 'https://platform.stability.ai/account/keys', 'sk-'),
  ('elevenlabs', 'ElevenLabs',   'https://elevenlabs.io/app/settings/api-keys', NULL),
  ('stripe',     'Stripe',       'https://dashboard.stripe.com/apikeys', 'sk_');
