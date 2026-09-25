import { json } from "../http";
import type { RouteHandler } from "./types";

/** GET /test-report (latest HTML report, public) and PUT /api/test-report (CI upload). */
export const reportsRoutes: RouteHandler = async ({ request, env, url }) => {
  if (url.pathname === "/test-report") {
    const html = await env.CREATORS.get("report:test-report:latest");
    if (!html) return new Response("No test report available yet.", { status: 404 });
    return new Response(html, { headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-cache" } });
  }

  if (url.pathname === "/api/test-report" && request.method === "PUT") {
    const body = await request.text();
    if (!body || body.length < 100) return json({ error: "Report body required" }, 400, request);
    if (body.length > 512_000) return json({ error: "Report too large (max 512KB)" }, 413, request);
    await env.CREATORS.put("report:test-report:latest", body);
    await env.CREATORS.put("report:test-report:updated", new Date().toISOString());
    return json({ ok: true, size: body.length }, 200, request);
  }

  return null;
};
