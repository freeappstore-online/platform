import { type DeprovisionRequest, handleDeprovision } from "../deprovision";
import type { Env } from "../helpers";
import { json } from "../http";
import type { RouteHandler } from "./types";

/** POST /api/unpublish (registry entry only) and POST /api/deprovision (full teardown). */
export const deprovisionRoutes: RouteHandler = async ({ request, env, url }) => {
  if (request.method !== "POST") return null;
  if (url.pathname === "/api/unpublish") return unpublish(request, env);
  if (url.pathname === "/api/deprovision") return deprovision(request, env);
  return null;
};

async function unpublish(request: Request, env: Env): Promise<Response> {
  try {
    const body = (await request.json()) as { id: string; store: "apps" | "games" };
    if (!body.id || !body.store) return json({ error: "id and store required" }, 400, request);
    const registryRepo = body.store === "apps" ? "freeappstore-online/freeappstore" : "freegamestore-online/freegamestore";
    const key = body.store === "apps" ? "apps" : "games";
    const regRes = await fetch(`https://api.github.com/repos/${registryRepo}/contents/registry.json`, {
      headers: {
        Authorization: `Bearer ${env.GITHUB_TOKEN}`,
        Accept: "application/vnd.github+json",
        "User-Agent": "freeappstore-admin",
      },
    });
    if (!regRes.ok) return json({ error: "Could not read registry" }, 500, request);
    const regFile = (await regRes.json()) as { content: string; sha: string };
    const registry = JSON.parse(atob(regFile.content.replace(/\n/g, "")));
    const before = registry[key]?.length ?? 0;
    registry[key] = (registry[key] || []).filter((a: any) => a.id !== body.id);
    if (registry[key].length === before) return json({ error: "Not found in registry" }, 404, request);
    const updateRes = await fetch(`https://api.github.com/repos/${registryRepo}/contents/registry.json`, {
      method: "PUT",
      headers: {
        Authorization: `Bearer ${env.GITHUB_TOKEN}`,
        Accept: "application/vnd.github+json",
        "User-Agent": "freeappstore-admin",
        "X-GitHub-Api-Version": "2022-11-28",
      },
      body: JSON.stringify({
        message: `Unpublish ${body.id}`,
        content: btoa(`${JSON.stringify(registry, null, 2)}\n`),
        sha: regFile.sha,
      }),
    });
    return json({ ok: updateRes.ok, id: body.id }, updateRes.ok ? 200 : 500, request);
  } catch (e) {
    return json({ error: String(e) }, 500, request);
  }
}

async function deprovision(request: Request, env: Env): Promise<Response> {
  try {
    const body = (await request.json()) as DeprovisionRequest;
    if (!body.id || !body.store) return json({ error: "id and store required" }, 400, request);
    const result = await handleDeprovision(body, {
      CF_ACCOUNT_ID: env.CF_ACCOUNT_ID,
      CF_API_TOKEN: env.CF_API_TOKEN,
      GITHUB_TOKEN: env.GITHUB_TOKEN,
      FAS_ZONE_ID: env.FAS_ZONE_ID,
      FGS_ZONE_ID: env.FGS_ZONE_ID,
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
