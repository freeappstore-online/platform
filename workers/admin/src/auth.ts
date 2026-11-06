import type { Env } from "./helpers";

interface AdminUser {
  id: string;
  login: string;
  githubLogin?: string;
  roles?: string[];
  /** The session's audience (#495): only a first-party (`console`) session may drive admin. */
  aud?: string;
}

export type AuthResult =
  | { ok: true; kind: "admin"; user: AdminUser }
  | { ok: true; kind: "service" | "ci" | "local" }
  | { ok: false; status: number; error: string };

/**
 * The backend reaches this Worker over its ADMIN service binding as
 * https://admin/…; no public hostname is ever `admin`, so the hostname proves
 * the call never crossed the internet. Mirrors the backend's
 * isServiceBindingCall (packages/backend/src/lib/internal.ts).
 */
export function isServiceBindingCall(request: Request): boolean {
  return new URL(request.url).hostname === "admin";
}

export async function authenticateApiRequest(request: Request, env: Env): Promise<AuthResult> {
  // Trusted server-to-server callers (the FAS backend → /api/provision via the
  // ADMIN service binding) present the shared ADMIN_PROVISION_TOKEN. The token
  // alone is not enough: from the public host a leaked token would reach every
  // /api/* route and the backend's /v1/internal/* behind the proxies (#513).
  const internalToken = request.headers.get("X-Internal-Token");
  if (
    isServiceBindingCall(request) &&
    env.ADMIN_PROVISION_TOKEN &&
    internalToken &&
    timingSafeEqual(internalToken, env.ADMIN_PROVISION_TOKEN)
  ) {
    return { ok: true, kind: "service" };
  }

  if (env.ALLOW_LOCAL_ADMIN_AUTH === "true") {
    return { ok: true, kind: "local" };
  }

  const auth = request.headers.get("Authorization");
  if (!auth?.startsWith("Bearer ")) return { ok: false, status: 401, error: "Unauthorized" };

  // Fail closed: a misdeploy (renamed binding, secret lost in a rotation) must
  // not turn into unauthenticated admin. Local mode is ALLOW_LOCAL_ADMIN_AUTH only (#521).
  if (!env.BACKEND_FAS) return { ok: false, status: 500, error: "admin auth is not wired (missing BACKEND_FAS)" };

  const res = await env.BACKEND_FAS.fetch("https://backend/v1/auth/me", {
    headers: { Authorization: auth },
  });
  if (!res.ok) return { ok: false, status: 401, error: "Unauthorized" };

  const user = (await res.json()) as AdminUser;
  // A token an app received is scoped to that app (#495) and a pre-#495 one
  // carries no audience: neither may provision, deprovision or moderate.
  if (user.aud !== "console") return { ok: false, status: 401, error: "console session required" };
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
