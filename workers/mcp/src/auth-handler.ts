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

/**
 * Catch-all for everything the OAuth provider does not claim. The provider owns
 * /token, /register and the discovery docs, and routes /mcp to the agent; this
 * app owns /authorize and /callback above, and lands here for `/` and any other
 * unmatched path.
 *
 * MCP protocol clients get the JSON-RPC 405 the spec asks for from an endpoint
 * with no stream to offer. That matters because of how a client reacts to the
 * alternative (#24): registered against the origin instead of /mcp, it opens
 * the legacy SSE transport with `GET / Accept: text/event-stream`, and a 200
 * carrying a body that ends immediately reads as "stream opened, then dropped".
 * The spec-correct response to a dropped stream is to reconnect, so it redials
 * ~1/sec, forever. The flood is invisible: every response is a 200, nothing
 * throws, no AI tokens are spent, nothing is written to D1, and the MCP rate
 * limiter only counts `tools/call` messages carrying an account, which a bare
 * GET has neither of. An identical bug on another project reached 91,806
 * requests in one day against a 50-125/day baseline before anyone noticed.
 *
 * This guard already existed once, in the hand-written `fetch()` (273f0ad), and
 * the OAuth 2.1 refactor deleted it along with that handler. What replaced it
 * answers 404, which happens to be fatal to an SSE client and so does not loop
 * — the right behaviour by accident. Hence both the deliberate 405 here and the
 * prod-smoke step that asserts it from outside the repo every 30 minutes.
 *
 * OPTIONS and HEAD fall through, so CORS preflight and link checkers are
 * unaffected.
 */
app.all("*", async (c, next) => {
  const { method, headers } = c.req.raw;
  const wantsStream = (headers.get("accept") ?? "").includes("text/event-stream");
  if (method !== "OPTIONS" && method !== "HEAD" && (method === "POST" || wantsStream)) {
    const endpoint = new URL("/mcp", c.req.url).toString();
    return c.json(
      {
        jsonrpc: "2.0",
        id: null,
        error: { code: -32000, message: `Method Not Allowed — the MCP endpoint is ${endpoint}` },
      },
      405,
      { allow: "GET, HEAD" },
    );
  }
  await next();
});

export { app as AuthHandler };
