// Browser Origin allowlist (#524). The MCP transport spec requires servers to
// validate Origin (DNS rebinding, cross-site browser calls). The OAuth provider
// reflects any Origin into Access-Control-Allow-Origin; this wrapper refuses
// the preflight and strips the CORS headers for an origin that is not listed.
// Requests with no Origin (native and server-side clients) pass untouched.

type FetchHandler<E> = (request: Request, env: E, ctx: ExecutionContext) => Promise<Response> | Response;

/** First-party sites, plus Claude's web client. */
const ALLOWED_ORIGINS = new Set([
  "https://freeappstore.online",
  "https://console.freeappstore.online",
  "https://claude.ai",
]);

export function isAllowedBrowserOrigin(origin: string): boolean {
  if (ALLOWED_ORIGINS.has(origin)) return true;
  try {
    const url = new URL(origin);
    // Local MCP clients and inspectors, on any port.
    return (url.protocol === "http:" || url.protocol === "https:") &&
      (url.hostname === "localhost" || url.hostname === "127.0.0.1") &&
      origin === url.origin;
  } catch {
    return false;
  }
}

export function withOriginCheck<E>(handler: FetchHandler<E>): FetchHandler<E> {
  return async (request, env, ctx) => {
    const origin = request.headers.get("Origin");
    if (origin === null || isAllowedBrowserOrigin(origin)) return handler(request, env, ctx);

    // A disallowed browser origin: refuse the preflight; for anything else
    // drop the CORS headers so the browser will not hand the response to the page.
    if (request.method === "OPTIONS") {
      return new Response(JSON.stringify({ error: "origin_not_allowed" }), {
        status: 403,
        headers: { "Content-Type": "application/json" },
      });
    }
    const res = await handler(request, env, ctx);
    const headers = new Headers(res.headers);
    for (const name of [...headers.keys()]) {
      if (name.toLowerCase().startsWith("access-control-")) headers.delete(name);
    }
    return new Response(res.body, { status: res.status, statusText: res.statusText, headers });
  };
}
