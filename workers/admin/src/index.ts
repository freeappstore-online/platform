// freeappstore-admin: auth / CORS / router shell. Route logic lives in
// src/routes/*; see README "Which APIs live here vs the backend".

import { type AuthResult, authenticateApiRequest, isCiTestReport } from "./auth";
import type { AppConfig, Env } from "./helpers";
import { corsHeaders, json } from "./http";
import { agentSessionsRoutes } from "./routes/agent-sessions";
import { aiKeysProxyRoutes } from "./routes/ai-keys-proxy";
import { appsRoutes } from "./routes/apps";
import { contentProxyRoutes } from "./routes/content-proxy";
import { creatorsRoutes } from "./routes/creators";
import { deprovisionRoutes } from "./routes/deprovision";
import { dnsRoutes } from "./routes/dns";
import { pingRoutes } from "./routes/ping";
import { provisionRoutes } from "./routes/provision";
import { reportsRoutes } from "./routes/reports";
import { statsRoutes } from "./routes/stats";
import type { RouteHandler } from "./routes/types";

export type { AppConfig, Env };

/** Tried in order; the first module to return a Response owns the request.
 *  Paths don't overlap between modules, but the order matches the original
 *  single handler so matching behaviour is unchanged. */
const ROUTES: RouteHandler[] = [
  pingRoutes,
  provisionRoutes,
  deprovisionRoutes,
  aiKeysProxyRoutes,
  contentProxyRoutes,
  statsRoutes,
  creatorsRoutes,
  reportsRoutes,
  dnsRoutes,
  appsRoutes,
  agentSessionsRoutes,
];

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: corsHeaders(request) });

    const url = new URL(request.url);

    // Every /api/* request is authenticated here, once, before any route runs.
    let auth: AuthResult | null = null;
    if (isCiTestReport(request, url, env)) {
      auth = { ok: true, kind: "ci" };
    } else if (url.pathname.startsWith("/api/")) {
      auth = await authenticateApiRequest(request, env);
      if (!auth.ok) return json({ error: auth.error }, auth.status, request);
    }

    for (const route of ROUTES) {
      const res = await route({ request, env, url, auth });
      if (res) return res;
    }

    if (url.pathname.startsWith("/api/")) return json({ error: "not found" }, 404, request);
    return new Response(null, { status: 404 });
  },
};
