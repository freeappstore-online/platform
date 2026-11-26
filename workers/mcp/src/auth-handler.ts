/**
 * OAuth default handler — the interactive login flow that @cloudflare/workers-
 * oauth-provider delegates to. The provider itself handles /register, /token,
 * the discovery docs, and the 401 challenge; this only owns the human step:
 * bounce the user to FreeAppStore's GitHub login, redeem what comes back, and
 * ask the user to approve the client, then hand the provider the user + props
 * via completeAuthorization.
 *
 * The session never travels in a URL. FAS is called with `response_mode=code`,
 * so the browser is redirected back with a one-time code that is worthless on
 * its own; this worker trades it for the session over a server-to-server POST,
 * authenticating itself with a PKCE verifier that never left the worker. The
 * previous contract put a reusable `?fas_session=` bearer token in the callback
 * URL, where it landed in request logs and browser history.
 *
 * Three independent things must line up for a callback to be accepted:
 *
 *   nonce   — keys the pending flow in KV; single-use, 10 minute TTL.
 *   state   — echoed through the provider round-trip and compared to the
 *             value recorded when the flow started.
 *   cookie  — an HttpOnly secret set at /authorize, stored only as a hash.
 *             This is what makes the flow browser-bound: nonce and state are
 *             both visible to the FAS backend and to anything that observes
 *             the redirect chain, but the cookie is not, so a captured
 *             callback URL cannot be replayed from another browser.
 *
 * None of that stops a victim's own browser from being walked through an
 * attacker's client: registration is open and a returning GitHub user comes
 * back without a prompt, so the grant would land on the attacker's
 * redirect_uri. The consent page (GET /callback → POST /callback) is the step
 * that names the client and asks first (#738).
 */

import type { AuthRequest, OAuthHelpers } from "@cloudflare/workers-oauth-provider";
import { Hono } from "hono";
import { generateVerifier, randomToken, s256Challenge, sha256Hex, timingSafeEqual } from "./pkce.js";
import { type McpScope, parseScopes } from "./safety.js";

type Bindings = {
  OAUTH_KV: KVNamespace;
  API_BASE: string;
  OAUTH_PROVIDER: OAuthHelpers;
};

/** How long the user has to finish the GitHub round-trip. */
const FLOW_TTL_SECONDS = 600;

/** The audience this worker needs: it calls console-only routes (/v1/publish, /v1/apps/mine). */
const CONSOLE_AUD = "console";

const COOKIE_BASE = "fas_mcp_flow";

/** The pending flow, held in KV under `authreq:<nonce>` for one round-trip. */
interface PendingAuth {
  req: AuthRequest;
  /** Echoed via return_to and compared on the way back. */
  state: string;
  /** PKCE verifier — presented to the backend to redeem the code. */
  codeVerifier: string;
  /** SHA-256 of the browser cookie secret; the secret itself is never stored. */
  browserHash: string;
}

/** A signed-in, verified user waiting on the consent page, under `consent:<nonce>`. */
interface PendingConsent {
  req: AuthRequest;
  browserHash: string;
  userId: string;
  login: string;
  /** The redeemed FAS session; becomes the grant's props token on Allow. */
  token: string;
  scopes: McpScope[];
}

interface SignedInUser {
  id: string;
  aud: string;
  login: string;
}

const app = new Hono<{ Bindings: Bindings }>();

/** GET /authorize — record the MCP client's OAuth request plus fresh state,
 *  PKCE verifier and browser secret, then send the user to FreeAppStore's
 *  GitHub login in code mode. */
app.get("/authorize", async (c) => {
  let oauthReqInfo: AuthRequest;
  try {
    oauthReqInfo = await c.env.OAUTH_PROVIDER.parseAuthRequest(c.req.raw);
  } catch (e) {
    // The provider throws on a malformed request — including a `plain`
    // code_challenge_method now that allowPlainPKCE is false. That is the
    // client's mistake, so answer 400 rather than letting it surface as a 500.
    return c.text(`Invalid request: ${e instanceof Error ? e.message : String(e)}`, 400);
  }
  if (!oauthReqInfo.clientId) return c.text("Invalid request", 400);

  const nonce = crypto.randomUUID();
  const state = randomToken();
  const codeVerifier = generateVerifier();
  const browserSecret = randomToken();

  const pending: PendingAuth = {
    req: oauthReqInfo,
    state,
    codeVerifier,
    browserHash: await sha256Hex(browserSecret),
  };
  await c.env.OAUTH_KV.put(`authreq:${nonce}`, JSON.stringify(pending), {
    expirationTtl: FLOW_TTL_SECONDS,
  });

  const callback = new URL("/callback", c.req.url);
  callback.searchParams.set("nonce", nonce);
  callback.searchParams.set("state", state);

  const login = new URL(`${c.env.API_BASE}/v1/auth/github/start`);
  login.searchParams.set("response_mode", "code");
  login.searchParams.set("code_challenge", await s256Challenge(codeVerifier));
  login.searchParams.set("code_challenge_method", "S256");
  login.searchParams.set("app_id", "mcp");
  login.searchParams.set("return_to", callback.toString());

  // Built by hand rather than c.redirect so the Set-Cookie rides along.
  return new Response(null, {
    status: 302,
    headers: {
      Location: login.toString(),
      "Set-Cookie": flowCookie(c.req.url, nonce, browserSecret),
    },
  });
});

/** GET /callback — FAS returns here with `?code=…`. Validate the flow is the
 *  one this browser started and redeem the code for the session, then ask the
 *  user to approve this client (#738). Nothing is granted on this leg. */
app.get("/callback", async (c) => {
  // Refuse the old contract outright. If FAS ever regresses to query delivery,
  // this fails loudly instead of silently accepting a token from the URL.
  if (c.req.query("fas_session")) {
    return c.text("fas_session in the callback URL is no longer accepted", 400);
  }

  const nonce = c.req.query("nonce");
  const state = c.req.query("state");
  const code = c.req.query("code");
  if (!nonce || !state || !code) return c.text("missing nonce, state or code", 400);

  const raw = await c.env.OAUTH_KV.get(`authreq:${nonce}`);
  if (!raw) return c.text("invalid or expired nonce", 400);
  // Single-use: burn the pending flow before doing anything with it, so a
  // replayed callback finds nothing regardless of how the rest goes.
  await c.env.OAUTH_KV.delete(`authreq:${nonce}`);

  let pending: PendingAuth;
  try {
    pending = JSON.parse(raw) as PendingAuth;
  } catch {
    return c.text("invalid OAuth request", 400);
  }
  if (!pending.req?.clientId) return c.text("invalid OAuth request", 400);

  if (!timingSafeEqual(state, pending.state)) return c.text("state mismatch", 400);

  if (!(await isFlowBrowser(c.req.raw, c.req.url, nonce, pending.browserHash))) {
    return c.text("this sign-in was started in a different browser — start again", 400);
  }

  let fasSession: string | null;
  let me: SignedInUser | null = null;
  try {
    fasSession = await exchangeCode(c.env.API_BASE, code, pending.codeVerifier);
    if (!fasSession) return c.text("could not redeem the sign-in code — start again", 400);
    // The backend is the only verifier: it checks signature, expiry and
    // revocation. The backend mints `aud: console` for app_id=mcp on this
    // worker's own origin (#495); anything else could not drive the tools below.
    me = await fetchMe(c.env.API_BASE, fasSession);
  } catch {
    return c.text("could not reach FreeAppStore to finish signing in — try connecting again in a moment", 502);
  }
  if (!me || me.aud !== CONSOLE_AUD) return c.text("invalid session", 400);

  const consent: PendingConsent = {
    req: pending.req,
    browserHash: pending.browserHash,
    userId: me.id,
    login: me.login,
    token: fasSession,
    scopes: parseScopes(pending.req.scope),
  };
  await c.env.OAUTH_KV.put(`consent:${nonce}`, JSON.stringify(consent), { expirationTtl: FLOW_TTL_SECONDS });
  const client = await c.env.OAUTH_PROVIDER.lookupClient(pending.req.clientId).catch(() => null);
  return new Response(consentPage(nonce, client?.clientName, pending.req.redirectUri, consent), {
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-store",
      "Content-Security-Policy":
        "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'",
      "X-Frame-Options": "DENY",
      "Referrer-Policy": "no-referrer",
    },
  });
});

/** POST /callback — the user's decision on the consent page. The parked grant
 *  is single-use and still bound to this browser's flow cookie, which a
 *  cross-site form POST does not carry (SameSite=Lax). Allow issues the MCP
 *  access token carrying the session + granted scopes as props (available as
 *  `this.props` inside the MCP agent); Deny sends the client access_denied. */
app.post("/callback", async (c) => {
  const form = await c.req.parseBody().catch(() => ({}) as Record<string, unknown>);
  const nonce = typeof form.nonce === "string" ? form.nonce : "";
  if (!nonce) return c.text("missing nonce", 400);

  const raw = await c.env.OAUTH_KV.get(`consent:${nonce}`);
  if (!raw) return c.text("invalid or expired sign-in — start again", 400);
  await c.env.OAUTH_KV.delete(`consent:${nonce}`);

  let consent: PendingConsent;
  try {
    consent = JSON.parse(raw) as PendingConsent;
  } catch {
    return c.text("invalid OAuth request", 400);
  }
  if (!(await isFlowBrowser(c.req.raw, c.req.url, nonce, consent.browserHash))) {
    return c.text("this sign-in was started in a different browser — start again", 400);
  }
  const cleared = clearFlowCookie(c.req.url, nonce);

  if (form.decision !== "allow") {
    const denied = new URL(consent.req.redirectUri);
    denied.searchParams.set("error", "access_denied");
    if (consent.req.state) denied.searchParams.set("state", consent.req.state);
    return new Response(null, { status: 302, headers: { Location: denied.toString(), "Set-Cookie": cleared } });
  }

  // The provider's tokens/codes are `userId:grantId:secret`, so the userId must
  // not contain a colon. FAS uids are `gh:123` / `google:<sub>` — pass a
  // colon-free id to the library and keep the real uid in props (used for
  // scoping + audit).
  const { redirectTo } = await c.env.OAUTH_PROVIDER.completeAuthorization({
    request: consent.req,
    userId: consent.userId.replace(/:/g, "_"),
    scope: consent.scopes,
    metadata: { label: consent.userId },
    props: { userId: consent.userId, token: consent.token, scopes: consent.scopes },
  });
  return new Response(null, { status: 302, headers: { Location: redirectTo, "Set-Cookie": cleared } });
});

/** What each scope lets the client do, shown on the consent page. */
const SCOPE_TEXT: Record<McpScope, string> = {
  read: "Read your apps, their files, deploy status and logs",
  write: "Create apps and change the code of apps you own",
  runtime: "Run the VibeCode build agent with the AI keys in your key vault",
  destructive: "Make changes that cannot be undone",
};

function escapeHtml(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

/** The consent page. The client name is chosen by whoever registered the client
 *  (registration is open), so the redirect host is shown next to it. */
function consentPage(nonce: string, clientName: string | undefined, redirectUri: string, consent: PendingConsent): string {
  let host = redirectUri;
  try {
    host = new URL(redirectUri).host || redirectUri;
  } catch {}
  const name = escapeHtml(clientName?.trim() || "An unnamed application");
  const account = escapeHtml(consent.login || consent.userId);
  const scopes = consent.scopes.map((s) => `<li>${escapeHtml(SCOPE_TEXT[s])}</li>`).join("");
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Allow access to FreeAppStore?</title>
<style>
body{margin:0;font:16px/1.5 system-ui,sans-serif;background:#f8fafc;color:#1e293b}
main{max-width:420px;margin:48px auto;padding:24px;background:#fff;border:1px solid #e2e8f0;border-radius:14px}
h1{font-size:20px;margin:0 0 12px}.muted{color:#64748b;font-size:14px}ul{padding-left:20px}
.row{display:flex;gap:8px;margin-top:20px}button{flex:1;min-height:44px;border-radius:10px;font:inherit;cursor:pointer}
.allow{border:0;background:#2563eb;color:#fff;font-weight:600}.deny{border:1px solid #e2e8f0;background:#fff;color:inherit}
@media (prefers-color-scheme:dark){body{background:#0f172a;color:#e2e8f0}main{background:#1e293b;border-color:#334155}.deny{background:#1e293b;border-color:#334155}.muted{color:#94a3b8}}
</style></head>
<body><main>
<h1>Allow ${name} to use your FreeAppStore account?</h1>
<p class="muted">Signed in as <strong>${account}</strong>. Access will be sent to <strong>${escapeHtml(host)}</strong>.</p>
<p>It will be able to:</p><ul>${scopes}</ul>
<p class="muted">Only allow this if you just connected FreeAppStore to this application yourself.</p>
<form method="post" action="/callback"><input type="hidden" name="nonce" value="${escapeHtml(nonce)}">
<div class="row"><button class="deny" type="submit" name="decision" value="deny">Deny</button>
<button class="allow" type="submit" name="decision" value="allow">Allow</button></div></form>
</main></body></html>`;
}

/** Ask the backend who a session belongs to. Null when it refuses the token. */
async function fetchMe(apiBase: string, session: string): Promise<SignedInUser | null> {
  const res = await fetch(`${apiBase}/v1/auth/me`, {
    headers: { Authorization: `Bearer ${session}`, "User-Agent": "freeappstore-mcp" },
  });
  if (!res.ok) return null;
  const data = (await res.json().catch(() => null)) as { id?: unknown; aud?: unknown; login?: unknown } | null;
  if (typeof data?.id !== "string" || typeof data.aud !== "string") return null;
  return { id: data.id, aud: data.aud, login: typeof data.login === "string" ? data.login : "" };
}

/** Trade the one-time code for the session, server to server. The verifier is
 *  the credential here — the code alone is not redeemable. */
async function exchangeCode(apiBase: string, code: string, codeVerifier: string): Promise<string | null> {
  const res = await fetch(`${apiBase}/v1/auth/session/exchange`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "User-Agent": "freeappstore-mcp" },
    body: JSON.stringify({ code, code_verifier: codeVerifier }),
  });
  if (!res.ok) return null;
  const data = (await res.json().catch(() => null)) as { fas_session?: string } | null;
  return data?.fas_session ?? null;
}

// ── flow cookie ─────────────────────────────────────────────────
// `__Host-` (which requires Secure) in production; the bare name over http so
// `wrangler dev` on localhost still works.

function isSecure(url: string): boolean {
  return new URL(url).protocol === "https:";
}

function cookieName(url: string, nonce: string): string {
  // One cookie per pending flow, named by its nonce: a second /authorize in the
  // same browser (another tab, or two MCP clients at once) must not overwrite
  // the first flow's secret. `__Host-` permits any name.
  const name = `${COOKIE_BASE}_${nonce}`;
  return isSecure(url) ? `__Host-${name}` : name;
}

function flowCookie(url: string, nonce: string, value: string): string {
  // SameSite=Lax still sends the cookie on the top-level GET navigation that
  // FAS redirects the browser through; Strict would drop it and break login.
  return [
    `${cookieName(url, nonce)}=${value}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
    ...(isSecure(url) ? ["Secure"] : []),
    `Max-Age=${FLOW_TTL_SECONDS}`,
  ].join("; ");
}

function clearFlowCookie(url: string, nonce: string): string {
  return [`${cookieName(url, nonce)}=`, "Path=/", "HttpOnly", "SameSite=Lax", ...(isSecure(url) ? ["Secure"] : []), "Max-Age=0"].join("; ");
}

/** True when this browser holds the flow cookie whose secret hashes to `browserHash`. */
async function isFlowBrowser(req: Request, url: string, nonce: string, browserHash: string): Promise<boolean> {
  const secret = readFlowCookie(req, url, nonce);
  return !!secret && timingSafeEqual(await sha256Hex(secret), browserHash);
}

function readFlowCookie(req: Request, url: string, nonce: string): string | null {
  const header = req.headers.get("Cookie");
  if (!header) return null;
  const name = cookieName(url, nonce);
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq < 0) continue;
    if (part.slice(0, eq).trim() !== name) continue;
    return part.slice(eq + 1).trim() || null;
  }
  return null;
}

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
