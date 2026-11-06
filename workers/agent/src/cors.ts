/** `http(s)://localhost[:port]` — compared by parsed hostname, so `http://localhost.evil.com` is not local. */
export function isLocalhostOrigin(origin: string): boolean {
  try {
    const url = new URL(origin);
    return (url.protocol === "http:" || url.protocol === "https:") && url.hostname === "localhost" && origin === url.origin;
  } catch {
    return false;
  }
}

/**
 * Browser callers: the creator console (the apex /app/ and its console host)
 * and local dev. Hosted apps on other subdomains are untrusted (#476).
 */
export function corsHeaders(request: Request, domain: string): Record<string, string> {
  const origin = request.headers.get("Origin");
  const allowed =
    origin && (origin === `https://${domain}` || origin === `https://console.${domain}` || isLocalhostOrigin(origin))
      ? origin
      : `https://${domain}`;
  return {
    "Access-Control-Allow-Origin": allowed,
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization, Last-Event-ID",
    "Access-Control-Expose-Headers": "Last-Event-ID",
    // Bearer-only API: no cookies are read or set, so no Allow-Credentials (#498).
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "strict-origin-when-cross-origin",
  };
}

export function json(data: unknown, status: number, request: Request, domain: string) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json", ...corsHeaders(request, domain) },
  });
}
