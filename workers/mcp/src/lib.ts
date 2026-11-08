// Pure utility functions extracted for testability.
// These have no Cloudflare runtime dependencies.

/** Namespace agent sessions under the caller's identity (hash of the full user id). */
export async function sessionPrefix(userId?: string): Promise<string> {
  const hash = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(userId ?? ""));
  const hex = [...new Uint8Array(hash).slice(0, 12)].map((b) => b.toString(16).padStart(2, "0")).join("");
  return `mcp-${hex}-`;
}

/** Pre-hash prefix (truncated id). Sessions created before the change keep working. */
export function legacySessionPrefix(userId?: string): string {
  const u = (userId ?? "").replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 24) || "anon";
  return `mcp-${u}-`;
}

/** Whether a session id is in the caller's namespace and a safe URL path segment. */
export async function ownsSession(userId: string | undefined, sessionId: string): Promise<boolean> {
  if (!/^[a-zA-Z0-9_-]+$/.test(sessionId)) return false;
  return sessionId.startsWith(await sessionPrefix(userId)) || sessionId.startsWith(legacySessionPrefix(userId));
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
