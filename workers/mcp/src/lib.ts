// Pure utility functions extracted for testability.
// These have no Cloudflare runtime dependencies.

/** Namespace agent sessions under the caller's identity. */
export function sessionPrefix(userId?: string): string {
  const u = (userId ?? "").replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 24) || "anon";
  return `mcp-${u}-`;
}

/** Structured audit log emitted as JSON to console (CF Worker tail / Logpush). */
export function auditLog(tool: string, userId: string | undefined, extra?: Record<string, unknown>) {
  console.log(JSON.stringify({ audit: "mcp", tool, userId: userId ?? "anon", ts: Date.now(), ...extra }));
}

/** Best-effort decode of the uid from a FAS session token payload. */
export function decodeUid(token: string): string | undefined {
  try {
    const b64 = token.split(".")[0].replace(/-/g, "+").replace(/_/g, "/");
    const json = JSON.parse(atob(b64.padEnd(b64.length + ((4 - (b64.length % 4)) % 4), "=")));
    return typeof json.uid === "string" ? json.uid : undefined;
  } catch {
    return undefined;
  }
}
