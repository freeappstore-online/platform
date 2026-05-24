-- Add OAuth2 client_credentials support to proxy allowlist.
-- secret_name_2 holds the client_secret reference (FK to app_secrets.name).
-- token_url is the OAuth2 token endpoint.
-- Both nullable — only used when inject_kind = 'oauth2_cc'.
ALTER TABLE app_proxy_allowlist ADD COLUMN secret_name_2 TEXT;
ALTER TABLE app_proxy_allowlist ADD COLUMN token_url TEXT;
