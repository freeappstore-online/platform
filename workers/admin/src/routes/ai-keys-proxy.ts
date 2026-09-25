import { json, relay } from "../http";
import type { RouteHandler } from "./types";

/** Admin path → [allowed method, backend internal path]. */
const ROUTES: Record<string, { method: "GET" | "POST"; backend: string }> = {
  "/api/ai-keys/users": { method: "GET", backend: "/v1/internal/keys/users" },
  "/api/ai-keys/providers": { method: "GET", backend: "/v1/internal/keys/providers" },
  "/api/ai-keys/userkey": { method: "POST", backend: "/v1/internal/keys/userkey" },
  "/api/ai-keys/userkey/delete": { method: "POST", backend: "/v1/internal/keys/userkey/delete" },
  "/api/ai-grants/users": { method: "GET", backend: "/v1/internal/keys/users" },
  "/api/ai-grants/delete": { method: "POST", backend: "/v1/internal/keys/grants/delete" },
};

/** AI key provisioning: proxies to the backend's /v1/internal/keys/* over the
 *  BACKEND_FAS service binding, authenticated with the internal token. */
export const aiKeysProxyRoutes: RouteHandler = async ({ request, env, url }) => {
  const method = request.method;
  // /api/ai-grants is the one path that takes both GET (list) and POST (grant).
  const route =
    url.pathname === "/api/ai-grants"
      ? { method: method === "POST" ? "POST" : "GET", backend: "/v1/internal/keys/grants" }
      : ROUTES[url.pathname];
  if (!route) return null;

  const backendToken = env.ADMIN_PROVISION_TOKEN || env.INTERNAL_TOKEN;
  if (!env.BACKEND_FAS || !backendToken) {
    return json({ error: "backend key provisioning is not wired (missing BACKEND_FAS or ADMIN_PROVISION_TOKEN)" }, 500, request);
  }
  if (method !== route.method) return json({ error: "method not allowed" }, 405, request);

  const res = await env.BACKEND_FAS.fetch(`https://backend${route.backend}`, {
    method,
    headers: {
      "Content-Type": "application/json",
      "X-Internal-Token": backendToken,
    },
    body: method === "POST" ? await request.text() : undefined,
  });
  return relay(res, request);
};
