// Browser Origin allowlist (#524). The MCP transport spec requires servers to
// validate Origin (DNS rebinding, cross-site browser calls). The OAuth provider
// reflects any Origin into Access-Control-Allow-Origin; this wrapper refuses
// every request carrying an Origin that is not listed (403).
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

    // A disallowed browser origin: refuse outright (preflight or not), so a
    // non-preflighted cross-site POST never reaches the handler. A same-origin
    // request (the MCP host's own pages) is not cross-site.
    if (origin === new URL(request.url).origin) return handler(request, env, ctx);
    return new Response(JSON.stringify({ error: "origin_not_allowed" }), {
      status: 403,
      headers: { "Content-Type": "application/json" },
    });
  };
}
