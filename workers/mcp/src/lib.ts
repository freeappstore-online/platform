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

export type OwnershipResult = { owned: boolean } | { error: string };

/**
 * Ownership gate for write tools: does the session user own this published app?
 *
 * `owned: false` is reserved for a confirmed answer — the backend listed the
 * caller's apps and this one was not among them. A non-2xx, a network failure
 * or a malformed body is returned as `error`, so an outage is reported as an
 * outage instead of telling the owner they don't own their app (#72).
 */
export async function checkOwnership(
  apiBase: string,
  token: string,
  appId: string,
  fetchImpl: typeof fetch = fetch,
): Promise<OwnershipResult> {
  let res: Response;
  try {
    res = await fetchImpl(`${apiBase}/v1/apps/mine`, {
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    });
  } catch (e) {
    return { error: `FAS API unreachable: ${String(e)}` };
  }
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    return { error: `FAS API ${res.status}${body ? `: ${body.slice(0, 200)}` : ""}` };
  }
  let data: { apps?: unknown };
  try {
    data = (await res.json()) as { apps?: unknown };
  } catch {
    return { error: "FAS API returned a non-JSON response" };
  }
  if (!Array.isArray(data?.apps)) return { error: "FAS API response is missing the apps list" };
  return { owned: (data.apps as Array<{ id?: unknown }>).some((a) => a?.id === appId) };
}
