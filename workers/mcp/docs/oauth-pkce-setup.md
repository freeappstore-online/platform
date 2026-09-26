# MCP OAuth + PKCE login

How `mcp.freeappstore.online` signs users in, and how another store's MCP Worker can copy it. The reference implementation is 7d48899 (#44). Its tests are `src/auth-handler.test.ts`; scope defaults are tested in `src/safety.test.ts` (#61).

## Two OAuth legs

An MCP client never talks to GitHub or the FAS backend directly. There are two separate OAuth exchanges, and the Worker sits in the middle of both:

1. **MCP client ↔ this Worker: OAuth 2.1.** This leg is handled by [`@cloudflare/workers-oauth-provider`](https://www.npmjs.com/package/@cloudflare/workers-oauth-provider). The library owns discovery (`/.well-known/oauth-authorization-server`), dynamic client registration (`/register`), `/token`, and the `401` challenge on `/mcp`. The client uses PKCE S256. `plain` is refused (`allowPlainPKCE: false`).
2. **This Worker ↔ FAS backend: a login with `response_mode=code`.** This leg is `src/auth-handler.ts`, which the library calls for `/authorize`. It sends the user through FreeAppStore's GitHub login and gets the FAS session back without it ever appearing in a URL.

## The flow, step by step

```
MCP client            MCP Worker                        FAS backend (api.freeappstore.online)
    │ GET /authorize?…     │                                     │
    │─────────────────────>│ store authreq:<nonce> in KV (10 min)│
    │                      │ set cookie __Host-fas_mcp_flow_<nonce>
    │  302 ────────────────│────> /v1/auth/github/start          │
    │                      │      ?response_mode=code            │
    │                      │      &code_challenge=S256(verifier) │
    │                      │      &app_id=mcp&return_to=/callback?nonce&state
    │        (user signs in with GitHub)                         │
    │                      │<──── 302 /callback?nonce&state&code │
    │                      │ burn nonce; check state + cookie    │
    │                      │ POST /v1/auth/session/exchange ────>│
    │                      │      {code, code_verifier}          │
    │                      │<──── {fas_session}                  │
    │                      │ verify session HMAC, parse scopes   │
    │<── 302 client redirect_uri?code=… (library)                │
    │ POST /token ────────>│ (library issues access + refresh)   │
    │ /mcp with Bearer ───>│ tools see this.props = {userId, token, scopes}
```

A callback is accepted only when three independent checks pass:

| Check | What it is | What it stops |
|---|---|---|
| `nonce` | Keys the pending flow in KV (`authreq:<nonce>`). Single-use: deleted before anything else is checked. 10-minute TTL. | Replaying a callback. |
| `state` | A random value recorded at `/authorize` and compared on return (timing-safe). | Mixing up or forging flows. |
| Flow cookie | An HttpOnly secret set at `/authorize`, stored only as a SHA-256 hash. One cookie per nonce. `__Host-` + `Secure` over https; the bare name over http, for `wrangler dev`. `SameSite=Lax`, because `Strict` would drop it on the redirect back. | A captured callback URL being used from another browser. Nonce and state are both visible in the redirect chain; the cookie is not. |

The FAS code is worthless without the PKCE verifier, which never leaves the Worker. The backend also enforces its side: codes last 60 s, are single-use, and every failure gets the same error message. A callback that carries `?fas_session=` (the old contract) is refused outright.

## Scopes

Declared in `src/safety.ts` (`MCP_SCOPES`) and advertised in the discovery document.

| Scope | Grants | Tools gated on it today |
|---|---|---|
| `read` | Reading platform and app data | `mcp_audit_log` |
| `write` | Changing an app's code or listing | `create_app`, `update_files` |
| `runtime` | Starting work that runs on the platform's side | `agent_build` |
| `destructive` | Irreversible operations | None yet |

- **No scope, or only unknown scopes** (e.g. `openid`): the client gets `read write runtime`. That covers most MCP clients, which send no `scope`.
- **`destructive`** is granted only when it is requested explicitly (#61).
- **Stored grants:** scopes are fixed on the grant at `/callback` and kept across token refresh until the user re-authorizes.
- **Ungated tools:** most read tools (`list_apps`, `app_info`, `read_file`, …) call no `requirePermission`, so any token can use them.
- **`MCP_READ_ONLY=1`:** disables every non-`read` tool server-wide.

## Copying this to another store

This is vendored code, not a package: copy the files and keep them in sync by hand.

**1. Files.** Copy `src/auth-handler.ts`, `src/pkce.ts`, `src/session.ts` and `src/safety.ts`, with their tests. `pkce.ts` must stay byte-identical to the backend's S256 in `packages/backend/src/lib/deliver-session.ts`. Change `COOKIE_BASE` and the `app_id` sent to `/start` if your backend needs a different one.

**2. Entry point.** Wire the library the same way as `src/index.ts`:

```ts
const oauthProvider = new OAuthProvider({
  apiRoute: "/mcp",
  apiHandler: YourMcpAgent.serve("/mcp"),
  defaultHandler: AuthHandler as any,
  authorizeEndpoint: "/authorize",
  tokenEndpoint: "/token",
  clientRegistrationEndpoint: "/register",
  scopesSupported: [...MCP_SCOPES],
  accessTokenTTL: 86_400,
  allowPlainPKCE: false,
});
```

The FAS Worker also wraps it in `withRateLimit` (`src/ratelimit.ts`, #68).

**3. `wrangler.toml`.**

```toml
[vars]
API_BASE = "https://api.freeappstore.online"   # the backend that runs /v1/auth/*

[[kv_namespaces]]
binding = "OAUTH_KV"      # the library's grants/tokens and this handler's authreq:<nonce> entries
id = "<your namespace id>"

[durable_objects]
bindings = [{ name = "MCP_OBJECT", class_name = "YourMcpAgent" }]

[[migrations]]
tag = "v1"
new_sqlite_classes = ["YourMcpAgent"]
```

**4. Secrets.** `SESSION_SIGNING_KEY` must be the same HMAC key the backend signs sessions with. Without it every callback fails with `invalid session`. Store it per the secrets process (SOPS inventory), not in the repo.

**5. Backend side.** The auth backend must:
- support `response_mode=code` with S256 on `/v1/auth/<provider>/start`, and `POST /v1/auth/session/exchange` (see `packages/backend/src/routes/auth.ts`);
- accept your Worker's `/callback` as a `return_to` for your `app_id` (`packages/backend/src/lib/origins.ts`). Subdomains of the store domains listed there are already allowed; a `*.workers.dev` host needs its own entry, like `isAllowedMcpWorkerReturn`.

**6. Tests.** Run `src/auth-handler.test.ts` against your copy. Each of the three checks above has a test that fails if the check is removed.

## Trying it with a real client

Claude Code:

```bash
claude mcp add --transport http freeappstore https://mcp.freeappstore.online/mcp
# then in a session: /mcp → freeappstore → Authenticate. A browser opens for GitHub sign-in.
```

Clients without native remote OAuth can use `npx mcp-remote https://mcp.freeappstore.online/mcp`, which runs the same flow.

To see the pieces by hand:

```bash
curl -s https://mcp.freeappstore.online/.well-known/oauth-authorization-server | jq '.scopes_supported, .code_challenge_methods_supported'
curl -si https://mcp.freeappstore.online/mcp | grep -i www-authenticate     # 401 + where to start
curl -s -X POST https://mcp.freeappstore.online/register \
  -H 'Content-Type: application/json' \
  -d '{"client_name":"test","redirect_uris":["http://localhost:9999/cb"],"token_endpoint_auth_method":"none"}'
```

After registration, open `/authorize?response_type=code&client_id=<id>&redirect_uri=http://localhost:9999/cb&code_challenge=<S256>&code_challenge_method=S256&state=<x>` in a browser. Sign in, then exchange the returned code at `/token` with your verifier. A real client does all of this for you.

**Not yet verified:** as of 2026-09-26, no real MCP client has been confirmed to complete this login against production (#61 item 2). That needs a human with the canary account. If it fails, the recovery path is rolling back the Worker alone.
