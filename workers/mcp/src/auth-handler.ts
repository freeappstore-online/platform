/**
 * OAuth default handler — the interactive login flow that @cloudflare/workers-
 * oauth-provider delegates to. The provider itself handles /register, /token,
 * the discovery docs, and the 401 challenge; this only owns the human step:
 * bounce the user to FreeAppStore's GitHub login, verify the returned signed
 * session, and hand the provider the user + props via completeAuthorization.
 */

import type { AuthRequest, OAuthHelpers } from "@cloudflare/workers-oauth-provider";
import { Hono } from "hono";
import { verifySession } from "./session.js";
import { parseScopes } from "./safety.js";

type Bindings = {
  OAUTH_KV: KVNamespace;
  API_BASE: string;
  SESSION_SIGNING_KEY?: string;
  OAUTH_PROVIDER: OAuthHelpers;
};

const app = new Hono<{ Bindings: Bindings }>();

/** GET /authorize — stash the MCP client's OAuth request, then send the user
 *  to FreeAppStore's GitHub login. FAS redirects back to /callback with a
 *  signed `fas_session`. */
app.get("/authorize", async (c) => {
  const oauthReqInfo = await c.env.OAUTH_PROVIDER.parseAuthRequest(c.req.raw);
  if (!oauthReqInfo.clientId) return c.text("Invalid request", 400);

  const nonce = crypto.randomUUID();
  await c.env.OAUTH_KV.put(`authreq:${nonce}`, JSON.stringify(oauthReqInfo), { expirationTtl: 600 });

  const callback = new URL("/callback", c.req.url);
  callback.searchParams.set("nonce", nonce);

  const login = new URL(`${c.env.API_BASE}/v1/auth/github/start`);
  login.searchParams.set("response_mode", "query");
  login.searchParams.set("app_id", "mcp");
  login.searchParams.set("return_to", callback.toString());
  return c.redirect(login.toString(), 302);
});

/** GET /callback — FAS returns here with `?fas_session=…`. Verify it and issue
 *  the MCP access token, carrying the FAS session + granted scopes as props
 *  (available as `this.props` inside the MCP agent). */
app.get("/callback", async (c) => {
  const nonce = c.req.query("nonce");
  const fasSession = c.req.query("fas_session");
  if (!nonce || !fasSession) return c.text("missing nonce or fas_session", 400);

  const raw = await c.env.OAUTH_KV.get(`authreq:${nonce}`);
  if (!raw) return c.text("invalid or expired nonce", 400);
  await c.env.OAUTH_KV.delete(`authreq:${nonce}`);
  const oauthReqInfo = JSON.parse(raw) as AuthRequest;
  if (!oauthReqInfo.clientId) return c.text("invalid OAuth request", 400);

  const payload = c.env.SESSION_SIGNING_KEY
    ? await verifySession(fasSession, c.env.SESSION_SIGNING_KEY)
    : null;
  if (!payload) return c.text("invalid session", 400);

  const scopes = parseScopes(oauthReqInfo.scope);
  // The provider's tokens/codes are `userId:grantId:secret`, so the userId must
  // not contain a colon. FAS uids are `gh:123` / `google:<sub>` — pass a
  // colon-free id to the library and keep the real uid in props (used for
  // scoping + audit).
  const libUserId = payload.uid.replace(/:/g, "_");
  const { redirectTo } = await c.env.OAUTH_PROVIDER.completeAuthorization({
    request: oauthReqInfo,
    userId: libUserId,
    scope: scopes,
    metadata: { label: payload.uid },
    props: { userId: payload.uid, token: fasSession, scopes },
  });
  return c.redirect(redirectTo, 302);
});

export { app as AuthHandler };
