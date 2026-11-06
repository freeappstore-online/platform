/** Response helpers shared by the router and every route module. */

/**
 * Browser callers of this API: the creator console at freeappstore.online/app/
 * (its R2 origin console.freeappstore.online) and local dev. The admin UI is
 * same-origin, the backend arrives over a service binding and the CLI has no
 * Origin. Hosted apps (*.freeappstore.online) are untrusted and never allowed,
 * and the API is bearer-only, so no Allow-Credentials either (#498).
 */
export const CORS_ORIGINS = new Set(["https://freeappstore.online", "https://console.freeappstore.online"]);

export function corsHeaders(request: Request): Record<string, string> {
  const origin = request.headers.get("Origin");
  const allowed = origin && (CORS_ORIGINS.has(origin) || origin.startsWith("http://localhost")) ? origin : "https://freeappstore.online";
  return {
    "Access-Control-Allow-Origin": allowed,
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Authorization, Content-Type",
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "strict-origin-when-cross-origin",
    "X-Frame-Options": "DENY",
  };
}

export function json(data: unknown, status: number, request: Request) {
  return new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json", ...corsHeaders(request) } });
}

export function parseJsonObject(value: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(value) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/** Relay a backend service-binding response to the browser, uncached. */
export async function relay(res: Response, request: Request): Promise<Response> {
  const text = await res.text();
  return new Response(text, {
    status: res.status,
    headers: {
      "Content-Type": res.headers.get("Content-Type") || "application/json",
      "Cache-Control": "no-store",
      ...corsHeaders(request),
    },
  });
}
