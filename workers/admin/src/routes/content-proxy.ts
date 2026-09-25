import { json, relay } from "../http";
import type { RouteHandler } from "./types";

const ALLOWED_METHODS: Record<string, string[]> = {
  "/api/content/kv": ["GET", "DELETE"],
  "/api/content/kv/value": ["GET"],
  "/api/content/collections": ["GET", "DELETE"],
  "/api/content/counters": ["GET", "DELETE"],
};

/** Content data (KV / Collections / Counters): proxies to /v1/internal/admin/*
 *  on the backend, gated by ADMIN_PROVISION_TOKEN. Every request reaching here
 *  has already passed the /api/* admin auth gate. */
export const contentProxyRoutes: RouteHandler = async ({ request, env, url }) => {
  const allowed = ALLOWED_METHODS[url.pathname];
  if (!allowed) return null;

  const backendToken = env.ADMIN_PROVISION_TOKEN || env.INTERNAL_TOKEN;
  if (!env.BACKEND_FAS || !backendToken) {
    return json({ error: "content data proxy not wired (missing BACKEND_FAS or ADMIN_PROVISION_TOKEN)" }, 500, request);
  }
  const method = request.method;
  if (!allowed.includes(method)) return json({ error: "method not allowed" }, 405, request);

  // Map admin worker path → backend internal path; forward query string unchanged.
  const internalPath = url.pathname.replace("/api/content/", "/v1/internal/admin/");
  const res = await env.BACKEND_FAS.fetch(`https://backend${internalPath}${url.search}`, {
    method,
    headers: {
      "Content-Type": "application/json",
      "X-Internal-Token": backendToken,
    },
  });
  return relay(res, request);
};
