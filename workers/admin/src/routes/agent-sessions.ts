import { handleAgentSessionDetail, handleAgentSessions } from "../helpers";
import { json } from "../http";
import type { RouteHandler } from "./types";

/** GET /api/agent/sessions (paged, searchable) and /api/agent/sessions/:id. */
export const agentSessionsRoutes: RouteHandler = async ({ request, env, url }) => {
  if (url.pathname === "/api/agent/sessions") {
    try {
      return json(await handleAgentSessions(url, env), 200, request);
    } catch (e) {
      return json({ error: String(e), sessions: [], total: 0 }, 500, request);
    }
  }

  const sessionMatch = url.pathname.match(/^\/api\/agent\/sessions\/([^/]+)$/);
  if (sessionMatch) {
    try {
      const data = await handleAgentSessionDetail(decodeURIComponent(sessionMatch[1]!), env);
      if (!data) return json({ error: "Session not found" }, 404, request);
      return json(data, 200, request);
    } catch (e) {
      return json({ error: String(e) }, 500, request);
    }
  }

  return null;
};
