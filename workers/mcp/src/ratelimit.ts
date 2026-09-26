// Per-IP request-rate limit in front of every route (#68). The OAuth
// provider's own checks only cover /register, /token and authenticated
// tool calls, so an unauthenticated GET flood skipped them by construction.
// This runs first, for every request. It caps what a flood can do to the
// Durable Object, KV and upstream APIs. It does not stop the Worker being
// invoked, so it does not cap Workers request usage; that still needs the
// edge rule tracked in #68.

export interface RateLimiter {
  limit(options: { key: string }): Promise<{ success: boolean }>;
}

/** Must match `simple.period` of the MCP_RATE_LIMIT binding in wrangler.toml. */
export const RATE_LIMIT_PERIOD_SECONDS = 60;

type FetchHandler<E> = (request: Request, env: E, ctx: ExecutionContext) => Promise<Response> | Response;

export function withRateLimit<E extends { MCP_RATE_LIMIT?: RateLimiter }>(handler: FetchHandler<E>): FetchHandler<E> {
  return async (request, env, ctx) => {
    // Unbound in `wrangler dev` and tests: no limit.
    if (env.MCP_RATE_LIMIT) {
      const ip = request.headers.get("CF-Connecting-IP") ?? "unknown";
      const { success } = await env.MCP_RATE_LIMIT.limit({ key: `mcp:${ip}` });
      if (!success) {
        return new Response(JSON.stringify({ error: "rate_limited", error_description: "Too many requests" }), {
          status: 429,
          headers: { "Content-Type": "application/json", "Retry-After": String(RATE_LIMIT_PERIOD_SECONDS) },
        });
      }
    }
    return handler(request, env, ctx);
  };
}
