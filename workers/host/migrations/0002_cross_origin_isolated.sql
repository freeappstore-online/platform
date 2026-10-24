-- Per-app COOP/COEP opt-in (#286). Default 0 so the ~150 existing apps are
-- unchanged. Host reads this on every request and, when 1, sends
-- Cross-Origin-Opener-Policy: same-origin and
-- Cross-Origin-Embedder-Policy: credentialless.
ALTER TABLE routes ADD COLUMN cross_origin_isolated INTEGER NOT NULL DEFAULT 0;
