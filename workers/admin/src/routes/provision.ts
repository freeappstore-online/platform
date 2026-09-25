import { json } from "../http";
import { handlePublish } from "../publish";
import type { RouteHandler } from "./types";

/** POST /api/provision — the 5-step publish (repo, route, DNS, registry, analytics). */
export const provisionRoutes: RouteHandler = async ({ request, env, url, auth }) => {
  if (url.pathname !== "/api/provision" || request.method !== "POST") return null;

  // Human admins are rate limited; service-binding calls (the backend's
  // /v1/publish) are not — the backend applies its own limits.
  if (auth?.ok && auth.kind === "admin") {
    try {
      const provUser = auth.user.githubLogin || auth.user.login || auth.user.id;
      if (provUser) {
        const rlKey = `ratelimit:${provUser}:provision`;
        const rlRaw = await env.CREATORS.get(rlKey);
        if (rlRaw && parseInt(rlRaw, 10) >= 3) return json({ error: "Rate limit: max 3 provisions per hour" }, 429, request);
        await env.CREATORS.put(rlKey, String((rlRaw ? parseInt(rlRaw, 10) : 0) + 1), { expirationTtl: 3600 });
      }
    } catch {
      return json({ error: "Invalid authentication" }, 401, request);
    }
  }
  try {
    const body = (await request.json()) as any;
    const result = await handlePublish(body, {
      CF_ACCOUNT_ID: env.CF_ACCOUNT_ID,
      CF_API_TOKEN: env.CF_API_TOKEN,
      GITHUB_TOKEN: env.GITHUB_TOKEN,
      FAS_ZONE_ID: env.FAS_ZONE_ID,
      FGS_ZONE_ID: env.FGS_ZONE_ID,
      DB: env.DB,
      // Required by the CF Web Analytics step to persist the minted
      // site_tag back into the FAS backend's app_analytics table. Omitting
      // these silently downgraded every publish to the "no FAS backend
      // binding — paste it manually" path, so no app ever got a token.
      BACKEND_FAS: env.BACKEND_FAS,
      ADMIN_PROVISION_TOKEN: env.ADMIN_PROVISION_TOKEN || env.INTERNAL_TOKEN,
    });
    return json(result, result.success ? 200 : 400, request);
  } catch (e) {
    const detail = e instanceof Error ? `${e.name}: ${e.message}` : String(e);
    return json({ error: "Provisioning failed", detail }, 500, request);
  }
};
