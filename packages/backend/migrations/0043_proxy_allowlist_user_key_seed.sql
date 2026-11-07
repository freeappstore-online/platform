-- Mandatory per-app proxy allowlist (#466).
--
-- Until now an app could reach a key-vault provider host (api.openai.com,
-- api.anthropic.com, ...) through the proxy with no rule at all; every other
-- host already needed a rule. The proxy now refuses any host without a rule, so
-- those provider hosts need one too: inject_kind 'user_key' spends the signed-in
-- user's own vault key, and has no secret (secret_name '').
--
-- Seed: the provider hosts existing apps actually call. The backend keeps no
-- per-host proxy history (app_proxy_usage counts requests per app and day, app_logs
-- is client log lines), so the hosts come from the app repos' source
-- (grep for proxy.fetch in every freeappstore-online repo, 2026-11-08):
--   agentcoder        web/src/use-translator.ts            api.anthropic.com  POST
--   smart-study-coach web/src/App.tsx and components/*.tsx api.openai.com     POST
-- Every other app that calls the proxy (flight-search, tennis-live,
-- kpop-concert-tracker) uses an app secret, which already needed a rule.
INSERT OR IGNORE INTO app_proxy_allowlist
  (app_id, pattern, inject_kind, inject_name, secret_name, methods, created_at)
VALUES
  ('agentcoder', 'https://api.anthropic.com/', 'user_key', '', '', 'POST', unixepoch() * 1000),
  ('smart-study-coach', 'https://api.openai.com/', 'user_key', '', '', 'POST', unixepoch() * 1000);
