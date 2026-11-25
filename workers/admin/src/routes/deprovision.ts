import { type DeprovisionRequest, handleDeprovision } from "../deprovision";
import type { Env } from "../helpers";
import { json } from "../http";
import type { RouteHandler } from "./types";

/** POST /api/deprovision (full teardown). */
export const deprovisionRoutes: RouteHandler = async ({ request, env, url }) => {
  if (request.method !== "POST" || url.pathname !== "/api/deprovision") return null;
  return deprovision(request, env);
};

async function deprovision(request: Request, env: Env): Promise<Response> {
  try {
    const body = (await request.json().catch(() => null)) as DeprovisionRequest | null;
    if (!body?.id || !body.store) return json({ error: "id and store required" }, 400, request);
    const result = await handleDeprovision(body, {
      CF_ACCOUNT_ID: env.CF_ACCOUNT_ID,
      CF_API_TOKEN: env.CF_API_TOKEN,
      GITHUB_TOKEN: env.GITHUB_TOKEN,
      FAS_ZONE_ID: env.FAS_ZONE_ID,
      DB: env.DB,
      APPS: env.APPS,
      BACKEND_FAS: env.BACKEND_FAS,
      ADMIN_PROVISION_TOKEN: env.ADMIN_PROVISION_TOKEN,
    });
    return json(result, result.ok ? 200 : 500, request);
  } catch {
    return json({ error: "Deprovision failed" }, 500, request);
  }
}
