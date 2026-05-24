-- One-time-use token tracking for magic link replay prevention.
-- The hash column stores SHA-256 of the signed token; expires_at
-- is the token's exp claim so the cron can prune expired entries.

CREATE TABLE IF NOT EXISTS consumed_tokens (
  hash        TEXT PRIMARY KEY,
  expires_at  INTEGER NOT NULL
);

-- Prune expired entries periodically (add to the 0 3 * * * cron).
CREATE INDEX IF NOT EXISTS idx_consumed_tokens_exp ON consumed_tokens (expires_at);
