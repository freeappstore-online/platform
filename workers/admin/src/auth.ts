import type { Env } from "./helpers";

interface AdminUser {
  id: string;
  login: string;
  githubLogin?: string;
  roles?: string[];
}

export type AuthResult =
  | { ok: true; kind: "admin"; user: AdminUser }
  | { ok: true; kind: "service" | "ci" | "local" }
  | { ok: false; status: number; error: string };

export async function authenticateApiRequest(request: Request, env: Env): Promise<AuthResult> {
  // Trusted server-to-server callers (the FAS backend → /api/provision via the
  // ADMIN service binding) present the shared ADMIN_PROVISION_TOKEN.
  const internalToken = request.headers.get("X-Internal-Token");
  if (env.ADMIN_PROVISION_TOKEN && internalToken && timingSafeEqual(internalToken, env.ADMIN_PROVISION_TOKEN)) {
    return { ok: true, kind: "service" };
  }

  if (env.ALLOW_LOCAL_ADMIN_AUTH === "true") {
    return { ok: true, kind: "local" };
  }

  const auth = request.headers.get("Authorization");
  if (!auth?.startsWith("Bearer ")) return { ok: false, status: 401, error: "Unauthorized" };

  if (!env.BACKEND_FAS) {
    // Local unit tests/dev can omit the backend binding. Production has it.
    if (!env.ADMIN_PROVISION_TOKEN) return { ok: true, kind: "local" };
    return { ok: false, status: 500, error: "admin auth is not wired (missing BACKEND_FAS)" };
  }

  const res = await env.BACKEND_FAS.fetch("https://backend/v1/auth/me", {
    headers: { Authorization: auth },
  });
  if (!res.ok) return { ok: false, status: 401, error: "Unauthorized" };

  const user = (await res.json()) as AdminUser;
  if (!Array.isArray(user.roles) || !user.roles.includes("admin")) {
    return { ok: false, status: 403, error: "admin only" };
  }
  return { ok: true, kind: "admin", user };
}

/**
 * CI uploads test reports with X-CI-Token and has no FAS session, so that one
 * path is let through before session auth. Without this the auth gate 401s it
 * and the CI-token branch is unreachable.
 */
export function isCiTestReport(request: Request, url: URL, env: Env): boolean {
  const provided = request.headers.get("X-CI-Token");
  return (
    url.pathname === "/api/test-report" &&
    request.method === "PUT" &&
    !!env.CI_TOKEN &&
    !!provided &&
    timingSafeEqual(provided, env.CI_TOKEN)
  );
}

/** Constant-time string compare for shared secrets (=== leaks the matching prefix through timing). */
export function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}
