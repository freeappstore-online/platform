/**
 * The interactive OAuth login (#44, #61). A callback is accepted only when the
 * nonce, the state and the browser-bound flow cookie all line up, and the
 * session is redeemed server-to-server with the PKCE verifier. These tests drive
 * the real Hono app with fake bindings: a Map-backed KV, a recording
 * OAUTH_PROVIDER, a stubbed FAS exchange, and a genuinely signed session so
 * verifySession runs for real.
 */

import type { AuthRequest, CompleteAuthorizationOptions } from "@cloudflare/workers-oauth-provider";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AuthHandler } from "./auth-handler.js";
import { s256Challenge, sha256Hex } from "./pkce.js";

const HTTPS = "https://mcp.test";
const API_BASE = "https://api.test";
const SIGNING_KEY = "test-signing-key";
const CLIENT_REDIRECT = "https://client.example/callback?code=provider-code";

const AUTH_REQUEST: AuthRequest = {
  responseType: "code",
  clientId: "client-123",
  redirectUri: "https://client.example/callback",
  scope: [],
  state: "client-state",
  codeChallenge: "client-challenge",
  codeChallengeMethod: "S256",
};

// ── fakes ───────────────────────────────────────────────────────

function fakeKv() {
  const store = new Map<string, string>();
  const ttls = new Map<string, number | undefined>();
  const kv = {
    async get(key: string) {
      return store.get(key) ?? null;
    },
    async put(key: string, value: string, opts?: { expirationTtl?: number }) {
      store.set(key, value);
      ttls.set(key, opts?.expirationTtl);
    },
    async delete(key: string) {
      store.delete(key);
    },
  };
  return { kv: kv as unknown as KVNamespace, store, ttls };
}

function makeEnv(overrides: { signingKey?: string | undefined; parseThrows?: boolean } = {}) {
  const { kv, store, ttls } = fakeKv();
  const completeAuthorization = vi.fn(async (_opts: CompleteAuthorizationOptions) => ({
    redirectTo: CLIENT_REDIRECT,
  }));
  const parseAuthRequest = vi.fn(async () => {
    if (overrides.parseThrows) throw new Error("Invalid code_challenge_method");
    return AUTH_REQUEST;
  });
  const env = {
    OAUTH_KV: kv,
    API_BASE,
    SESSION_SIGNING_KEY: "signingKey" in overrides ? overrides.signingKey : SIGNING_KEY,
    OAUTH_PROVIDER: { parseAuthRequest, completeAuthorization },
  };
  return { env, store, ttls, completeAuthorization, parseAuthRequest };
}

function b64url(bytes: Uint8Array): string {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** A FAS session token in the backend's format: base64url(payload).base64url(hmac). */
async function signSession(payload: Record<string, unknown>, key = SIGNING_KEY): Promise<string> {
  const body = b64url(new TextEncoder().encode(JSON.stringify(payload)));
  const hmacKey = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(key),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", hmacKey, new TextEncoder().encode(body));
  return `${body}.${b64url(new Uint8Array(sig))}`;
}

function validPayload() {
  const now = Math.floor(Date.now() / 1000);
  return { uid: "gh:2824906", iat: now, exp: now + 3600 };
}

/** Stub the FAS code exchange. Records every call so tests can inspect the body. */
function stubExchange(respond: () => Response | Promise<Response>) {
  const calls: { url: string; body: { code?: string; code_verifier?: string } }[] = [];
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ url: String(input), body: JSON.parse(String(init?.body ?? "{}")) });
    return respond();
  });
  vi.stubGlobal("fetch", fetchMock);
  return { calls, fetchMock };
}

// ── flow helpers ────────────────────────────────────────────────

interface Flow {
  /** The callback URL FAS would send the browser back to (nonce + state, no code yet). */
  callback: URL;
  nonce: string;
  state: string;
  /** `name=value` exactly as the browser would send it back. */
  cookie: string;
  setCookie: string;
  login: URL;
}

async function startFlow(env: ReturnType<typeof makeEnv>["env"], base = HTTPS): Promise<Flow> {
  const res = await AuthHandler.request(`${base}/authorize?response_type=code&client_id=client-123`, {}, env);
  expect(res.status).toBe(302);
  const login = new URL(res.headers.get("Location") ?? "");
  const callback = new URL(login.searchParams.get("return_to") ?? "");
  const setCookie = res.headers.get("Set-Cookie") ?? "";
  return {
    callback,
    nonce: callback.searchParams.get("nonce") ?? "",
    state: callback.searchParams.get("state") ?? "",
    cookie: setCookie.split(";")[0],
    setCookie,
    login,
  };
}

function callbackUrl(flow: Flow, params: Record<string, string | null> = {}): string {
  const url = new URL(flow.callback);
  url.searchParams.set("code", "one-time-code");
  for (const [k, v] of Object.entries(params)) {
    if (v === null) url.searchParams.delete(k);
    else url.searchParams.set(k, v);
  }
  return url.toString();
}

function callback(env: ReturnType<typeof makeEnv>["env"], url: string, cookie?: string) {
  return AuthHandler.request(url, cookie ? { headers: { Cookie: cookie } } : {}, env);
}

afterEach(() => {
  vi.unstubAllGlobals();
});

// ── /callback ───────────────────────────────────────────────────

describe("GET /callback", () => {
  let token: string;

  beforeEach(async () => {
    token = await signSession(validPayload());
  });

  it("accepts a matching nonce, state and cookie, redeems with the PKCE verifier, and completes authorization", async () => {
    const { env, completeAuthorization } = makeEnv();
    const exchange = stubExchange(() => Response.json({ fas_session: token }));
    const flow = await startFlow(env);

    const res = await callback(env, callbackUrl(flow), flow.cookie);

    expect(res.status).toBe(302);
    expect(res.headers.get("Location")).toBe(CLIENT_REDIRECT);
    // The flow cookie is cleared on the way out.
    const cleared = res.headers.get("Set-Cookie") ?? "";
    expect(cleared.startsWith(`${flow.cookie.split("=")[0]}=;`)).toBe(true);
    expect(cleared).toContain("Max-Age=0");

    // Redeemed server-to-server with the verifier whose challenge went to FAS.
    expect(exchange.calls).toHaveLength(1);
    expect(exchange.calls[0].url).toBe(`${API_BASE}/v1/auth/session/exchange`);
    expect(exchange.calls[0].body.code).toBe("one-time-code");
    const verifier = exchange.calls[0].body.code_verifier ?? "";
    expect(await s256Challenge(verifier)).toBe(flow.login.searchParams.get("code_challenge"));

    expect(completeAuthorization).toHaveBeenCalledTimes(1);
    const opts = completeAuthorization.mock.calls[0][0];
    expect(opts.request).toEqual(AUTH_REQUEST);
    // The provider's ids are colon-delimited, so the uid is passed colon-free;
    // the real uid rides in props.
    expect(opts.userId).toBe("gh_2824906");
    expect(opts.props).toMatchObject({ userId: "gh:2824906", token });
    expect(opts.props.scopes).toEqual(opts.scope);
  });

  it("rejects a callback with no flow cookie, before redeeming anything", async () => {
    const { env, completeAuthorization } = makeEnv();
    const exchange = stubExchange(() => Response.json({ fas_session: token }));
    const flow = await startFlow(env);

    const res = await callback(env, callbackUrl(flow));

    expect(res.status).toBe(400);
    expect(await res.text()).toContain("different browser");
    expect(exchange.fetchMock).not.toHaveBeenCalled();
    expect(completeAuthorization).not.toHaveBeenCalled();
  });

  it("rejects a flow cookie carrying another browser's secret", async () => {
    const { env, completeAuthorization } = makeEnv();
    const exchange = stubExchange(() => Response.json({ fas_session: token }));
    const flow = await startFlow(env);
    const name = flow.cookie.split("=")[0];

    const res = await callback(env, callbackUrl(flow), `${name}=attacker-secret`);

    expect(res.status).toBe(400);
    expect(await res.text()).toContain("different browser");
    expect(exchange.fetchMock).not.toHaveBeenCalled();
    expect(completeAuthorization).not.toHaveBeenCalled();
  });

  it("rejects a cookie that belongs to a different pending flow", async () => {
    const { env, completeAuthorization } = makeEnv();
    const exchange = stubExchange(() => Response.json({ fas_session: token }));
    const flowA = await startFlow(env);
    const flowB = await startFlow(env);
    expect(flowA.nonce).not.toBe(flowB.nonce);

    // Flow A's callback, presenting only flow B's (valid) cookie.
    const res = await callback(env, callbackUrl(flowA), flowB.cookie);

    expect(res.status).toBe(400);
    expect(await res.text()).toContain("different browser");
    expect(exchange.fetchMock).not.toHaveBeenCalled();
    expect(completeAuthorization).not.toHaveBeenCalled();
  });

  it("accepts each of two concurrent flows with its own cookie", async () => {
    const { env, completeAuthorization } = makeEnv();
    stubExchange(() => Response.json({ fas_session: token }));
    const flowA = await startFlow(env);
    const flowB = await startFlow(env);
    const both = `${flowA.cookie}; ${flowB.cookie}`;

    expect((await callback(env, callbackUrl(flowB), both)).status).toBe(302);
    expect((await callback(env, callbackUrl(flowA), both)).status).toBe(302);
    expect(completeAuthorization).toHaveBeenCalledTimes(2);
  });

  it("rejects a state that does not match the recorded flow", async () => {
    const { env, completeAuthorization } = makeEnv();
    const exchange = stubExchange(() => Response.json({ fas_session: token }));
    const flow = await startFlow(env);

    const res = await callback(env, callbackUrl(flow, { state: "forged-state" }), flow.cookie);

    expect(res.status).toBe(400);
    expect(await res.text()).toBe("state mismatch");
    expect(exchange.fetchMock).not.toHaveBeenCalled();
    expect(completeAuthorization).not.toHaveBeenCalled();
  });

  it("rejects a replayed callback: the nonce is single-use", async () => {
    const { env, completeAuthorization } = makeEnv();
    stubExchange(() => Response.json({ fas_session: token }));
    const flow = await startFlow(env);
    const url = callbackUrl(flow);

    expect((await callback(env, url, flow.cookie)).status).toBe(302);
    const replay = await callback(env, url, flow.cookie);

    expect(replay.status).toBe(400);
    expect(await replay.text()).toBe("invalid or expired nonce");
    expect(completeAuthorization).toHaveBeenCalledTimes(1);
  });

  it("burns the nonce even when a later check fails, so a corrected retry cannot reuse it", async () => {
    const { env, store, completeAuthorization } = makeEnv();
    stubExchange(() => Response.json({ fas_session: token }));
    const flow = await startFlow(env);
    expect(store.has(`authreq:${flow.nonce}`)).toBe(true);

    const bad = await callback(env, callbackUrl(flow, { state: "forged-state" }), flow.cookie);
    expect(bad.status).toBe(400);
    expect(store.has(`authreq:${flow.nonce}`)).toBe(false);

    const retry = await callback(env, callbackUrl(flow), flow.cookie);
    expect(retry.status).toBe(400);
    expect(await retry.text()).toBe("invalid or expired nonce");
    expect(completeAuthorization).not.toHaveBeenCalled();
  });

  it("refuses a session delivered in the callback URL (the pre-#44 contract)", async () => {
    const { env, store, completeAuthorization } = makeEnv();
    const exchange = stubExchange(() => Response.json({ fas_session: token }));
    const flow = await startFlow(env);

    const res = await callback(env, callbackUrl(flow, { fas_session: token }), flow.cookie);

    expect(res.status).toBe(400);
    expect(await res.text()).toContain("no longer accepted");
    // Refused before the flow is even looked up.
    expect(store.has(`authreq:${flow.nonce}`)).toBe(true);
    expect(exchange.fetchMock).not.toHaveBeenCalled();
    expect(completeAuthorization).not.toHaveBeenCalled();
  });

  it.each(["nonce", "state", "code"])("rejects a callback missing %s", async (param) => {
    const { env, completeAuthorization } = makeEnv();
    const exchange = stubExchange(() => Response.json({ fas_session: token }));
    const flow = await startFlow(env);

    const res = await callback(env, callbackUrl(flow, { [param]: null }), flow.cookie);

    expect(res.status).toBe(400);
    expect(await res.text()).toBe("missing nonce, state or code");
    expect(exchange.fetchMock).not.toHaveBeenCalled();
    expect(completeAuthorization).not.toHaveBeenCalled();
  });

  it("rejects an unknown or expired nonce", async () => {
    const { env, completeAuthorization } = makeEnv();
    stubExchange(() => Response.json({ fas_session: token }));
    const flow = await startFlow(env);

    const res = await callback(env, callbackUrl(flow, { nonce: crypto.randomUUID() }), flow.cookie);

    expect(res.status).toBe(400);
    expect(await res.text()).toBe("invalid or expired nonce");
    expect(completeAuthorization).not.toHaveBeenCalled();
  });

  describe("when redeeming or verifying the session fails", () => {
    it.each([
      ["FAS rejects the code", () => new Response("bad code", { status: 400 })],
      ["FAS answers 200 without a session", () => Response.json({})],
      ["FAS answers 200 with a non-JSON body", () => new Response("not json", { status: 200 })],
    ])("rejects when %s", async (_label, respond) => {
      const { env, completeAuthorization } = makeEnv();
      stubExchange(respond);
      const flow = await startFlow(env);

      const res = await callback(env, callbackUrl(flow), flow.cookie);

      expect(res.status).toBe(400);
      expect(await res.text()).toContain("could not redeem the sign-in code");
      expect(completeAuthorization).not.toHaveBeenCalled();
    });

    it("rejects a session signed with the wrong key", async () => {
      const { env, completeAuthorization } = makeEnv();
      const forged = await signSession(validPayload(), "not-the-signing-key");
      stubExchange(() => Response.json({ fas_session: forged }));
      const flow = await startFlow(env);

      const res = await callback(env, callbackUrl(flow), flow.cookie);

      expect(res.status).toBe(400);
      expect(await res.text()).toBe("invalid session");
      expect(completeAuthorization).not.toHaveBeenCalled();
    });

    it("rejects an expired session", async () => {
      const { env, completeAuthorization } = makeEnv();
      const now = Math.floor(Date.now() / 1000);
      const expired = await signSession({ uid: "gh:2824906", iat: now - 7200, exp: now - 3600 });
      stubExchange(() => Response.json({ fas_session: expired }));
      const flow = await startFlow(env);

      const res = await callback(env, callbackUrl(flow), flow.cookie);

      expect(res.status).toBe(400);
      expect(await res.text()).toBe("invalid session");
      expect(completeAuthorization).not.toHaveBeenCalled();
    });

    it("rejects every session when SESSION_SIGNING_KEY is not configured", async () => {
      const { env, completeAuthorization } = makeEnv({ signingKey: undefined });
      stubExchange(() => Response.json({ fas_session: token }));
      const flow = await startFlow(env);

      const res = await callback(env, callbackUrl(flow), flow.cookie);

      expect(res.status).toBe(400);
      expect(await res.text()).toBe("invalid session");
      expect(completeAuthorization).not.toHaveBeenCalled();
    });
  });

  describe("flow cookie naming follows the scheme", () => {
    it("uses a __Host- cookie with Secure over https", async () => {
      const { env } = makeEnv();
      const flow = await startFlow(env, HTTPS);

      expect(flow.cookie.startsWith(`__Host-fas_mcp_flow_${flow.nonce}=`)).toBe(true);
      expect(flow.setCookie).toContain("Secure");
      expect(flow.setCookie).toContain("HttpOnly");
      expect(flow.setCookie).toContain("SameSite=Lax");
      expect(flow.setCookie).toContain("Path=/");
      expect(flow.setCookie).toContain("Max-Age=600");
    });

    it("uses the bare name without Secure over http, and the flow still completes (wrangler dev)", async () => {
      const { env, completeAuthorization } = makeEnv();
      stubExchange(() => Response.json({ fas_session: token }));
      const flow = await startFlow(env, "http://localhost:8787");

      expect(flow.cookie.startsWith(`fas_mcp_flow_${flow.nonce}=`)).toBe(true);
      expect(flow.setCookie).not.toContain("Secure");

      const res = await callback(env, callbackUrl(flow), flow.cookie);
      expect(res.status).toBe(302);
      expect(res.headers.get("Set-Cookie")).not.toContain("Secure");
      expect(completeAuthorization).toHaveBeenCalledTimes(1);
    });

    it("does not accept the http cookie name on an https callback", async () => {
      const { env, completeAuthorization } = makeEnv();
      stubExchange(() => Response.json({ fas_session: token }));
      const flow = await startFlow(env, HTTPS);
      const value = flow.cookie.slice(flow.cookie.indexOf("=") + 1);

      const res = await callback(env, callbackUrl(flow), `fas_mcp_flow_${flow.nonce}=${value}`);

      expect(res.status).toBe(400);
      expect(completeAuthorization).not.toHaveBeenCalled();
    });
  });
});

// ── /authorize ──────────────────────────────────────────────────

describe("GET /authorize", () => {
  it("sends the user to FAS login in code mode with an S256 challenge, and records the flow", async () => {
    const { env, store, ttls } = makeEnv();
    const flow = await startFlow(env);

    expect(`${flow.login.origin}${flow.login.pathname}`).toBe(`${API_BASE}/v1/auth/github/start`);
    expect(flow.login.searchParams.get("response_mode")).toBe("code");
    expect(flow.login.searchParams.get("code_challenge_method")).toBe("S256");
    expect(flow.login.searchParams.get("app_id")).toBe("mcp");
    expect(`${flow.callback.origin}${flow.callback.pathname}`).toBe(`${HTTPS}/callback`);

    const key = `authreq:${flow.nonce}`;
    expect(ttls.get(key)).toBe(600);
    const pending = JSON.parse(store.get(key) ?? "{}");
    expect(pending.req).toEqual(AUTH_REQUEST);
    expect(pending.state).toBe(flow.state);
    // The challenge sent to FAS is derived from the verifier kept server-side.
    expect(await s256Challenge(pending.codeVerifier)).toBe(flow.login.searchParams.get("code_challenge"));
    // Only the hash of the browser secret is stored, never the secret itself.
    const secret = flow.cookie.slice(flow.cookie.indexOf("=") + 1);
    expect(pending.browserHash).toBe(await sha256Hex(secret));
    expect(store.get(key)).not.toContain(secret);
  });

  it("answers 400, not 500, when the provider rejects the OAuth request", async () => {
    const { env, store } = makeEnv({ parseThrows: true });

    const res = await AuthHandler.request(`${HTTPS}/authorize?code_challenge_method=plain`, {}, env);

    expect(res.status).toBe(400);
    expect(await res.text()).toContain("Invalid request");
    expect(store.size).toBe(0);
  });
});

// ── catch-all (#24) ─────────────────────────────────────────────

describe("catch-all for unmatched paths", () => {
  it.each([
    ["GET / as an SSE client", "/", { headers: { Accept: "text/event-stream" } }],
    ["POST / with a JSON-RPC body", "/", { method: "POST", body: '{"jsonrpc":"2.0","id":1,"method":"initialize"}' }],
    ["an SSE request on any other path", "/not-mcp", { headers: { Accept: "text/event-stream" } }],
  ])("answers %s with a JSON-RPC 405 pointing at /mcp", async (_label, path, init) => {
    const { env } = makeEnv();

    const res = await AuthHandler.request(`${HTTPS}${path}`, init, env);

    expect(res.status).toBe(405);
    expect(res.headers.get("allow")).toBe("GET, HEAD");
    const body = (await res.json()) as { jsonrpc: string; error: { message: string } };
    expect(body.jsonrpc).toBe("2.0");
    expect(body.error.message).toContain(`${HTTPS}/mcp`);
  });

  it.each([
    ["OPTIONS (CORS preflight)", { method: "OPTIONS", headers: { Accept: "text/event-stream" } }],
    ["HEAD", { method: "HEAD", headers: { Accept: "text/event-stream" } }],
    ["a plain GET", {}],
  ])("lets %s fall through instead of 405ing", async (_label, init) => {
    const { env } = makeEnv();

    const res = await AuthHandler.request(`${HTTPS}/`, init, env);

    expect(res.status).not.toBe(405);
  });
});
