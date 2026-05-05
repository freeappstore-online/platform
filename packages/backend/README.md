# @freeappstore/backend

The Cloudflare Worker that powers `@freeappstore/sdk`.

Stack: Workers + D1 (users + per-user KV) + Durable Objects (rooms) + Hono. One Worker, one D1 database, one DO class.

Not published to npm — deployed as a CF Worker via `wrangler deploy`.

## Routes

| Method + path | Module | Notes |
|---|---|---|
| `GET /health` | — | `{ ok: true }` |
| `GET /v1/auth/github/start?app_id=&return_to=` | auth | Redirects to GitHub. `return_to` must match the allowlist (see `lib/origins.ts`). |
| `GET /v1/auth/github/callback?code=&state=` | auth | OAuth callback. Verifies signed state, mints session, redirects to `return_to#fas_session=…`. |
| `GET /v1/auth/me` | auth | Returns the current user given a `Authorization: Bearer <session>` header. |
| `GET /v1/apps/:appId/kv/:key` | kv | Per-user, per-app KV read. |
| `PUT /v1/apps/:appId/kv/:key` | kv | KV write. Enforces per-user quotas (`lib/quota.ts`). |
| `DELETE /v1/apps/:appId/kv/:key` | kv | KV delete. |
| `GET /v1/apps/:appId/rooms/:roomId` (WebSocket upgrade, `?token=`) | rooms | Routes to `Room` DO. |

## Local dev

```bash
# In packages/backend/
wrangler d1 create fas      # one-time, paste the database_id into wrangler.toml
pnpm db:migrate:local       # apply migrations to local D1
pnpm dev                    # wrangler dev on http://localhost:8787
```

For the GitHub OAuth flow to work locally, set up a GitHub OAuth App with `http://localhost:8787/v1/auth/github/callback` as the callback, and:

```bash
echo 'dev-client-id'      | wrangler secret put GITHUB_CLIENT_ID --local
echo 'dev-client-secret'  | wrangler secret put GITHUB_CLIENT_SECRET --local
openssl rand -hex 32      | wrangler secret put SESSION_SIGNING_KEY --local
```

## Deploy

```bash
pnpm db:migrate:prod
wrangler secret put GITHUB_CLIENT_ID
wrangler secret put GITHUB_CLIENT_SECRET
wrangler secret put SESSION_SIGNING_KEY
pnpm deploy
```

Then attach the custom domain `api.freeappstore.online` to this Worker via the Cloudflare dashboard (Workers Routes or custom domains).

## Security model

- **Sessions** are HMAC-SHA256 signed bearer tokens with 30-day TTL. Rotating `SESSION_SIGNING_KEY` invalidates every active session.
- **OAuth state** is HMAC-signed with the same key and has a 10-minute TTL.
- **`return_to`** in the OAuth flow is allowlisted (`*.freeappstore.online` + localhost). Without this allowlist an attacker could craft a sign-in URL pointing `return_to` at their own site and exfiltrate the session token from the redirect fragment.
- **KV writes** are pre-checked against per-user quotas (`lib/quota.ts`) using a single SUM aggregate over the user's keys.

## License

MIT.
