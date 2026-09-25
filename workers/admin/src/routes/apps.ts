import { handleAppDeployStatus, handleAppHealth, handleAppSessions, handleAppsAll, handleDeployStatus } from "../helpers";
import { corsHeaders, json } from "../http";
import type { RouteHandler } from "./types";

// `caches.default` is a Cloudflare Workers extension (not in DOM CacheStorage types).
const workerCache = () => (caches as unknown as { default: Cache }).default;

/** Serve `produce()` from the Worker cache for `maxAge` seconds. */
async function cachedJson(request: Request, key: string, maxAge: number, produce: () => Promise<unknown>): Promise<Response> {
  const cache = workerCache();
  const cacheKey = new Request(key);
  const hit = await cache.match(cacheKey);
  if (hit) return new Response(hit.body, { status: 200, headers: { "Content-Type": "application/json", ...corsHeaders(request) } });
  try {
    const body = JSON.stringify(await produce());
    await cache.put(
      cacheKey,
      new Response(body, { headers: { "Content-Type": "application/json", "Cache-Control": `public, max-age=${maxAge}` } }),
    );
    return new Response(body, { status: 200, headers: { "Content-Type": "application/json", ...corsHeaders(request) } });
  } catch (e) {
    return json({ error: String(e) }, 500, request);
  }
}

/** /api/apps/all, /api/apps/deploy-status and the per-app /api/apps/:id/* reads. */
export const appsRoutes: RouteHandler = async ({ request, env, url }) => {
  // Unified apps (R2 + registry + D1)
  if (url.pathname === "/api/apps/all") {
    try {
      return json(await handleAppsAll(env), 200, request);
    } catch (e) {
      return json({ error: "Internal error", detail: String(e) }, 500, request);
    }
  }

  // Deploy status for every app (latest GH Actions conclusion). Cached 5 min so
  // the Apps list can flag failed deploys without a GitHub fan-out on every load.
  if (url.pathname === "/api/apps/deploy-status") {
    return cachedJson(request, "https://admin.internal/api/apps/deploy-status", 300, () => handleDeployStatus(env));
  }

  // Deploy status for ONE app. Same GitHub data, scoped to a single repo so the
  // creator console can ask about the app on screen without pulling the whole
  // org. Cached per app for 60s, not the fan-out's 5 min: a creator watching
  // their own deploy land needs this to move (#32).
  const deployStatusMatch = url.pathname.match(/^\/api\/apps\/([^/]+)\/deploy-status$/);
  if (deployStatusMatch) {
    const appId = decodeURIComponent(deployStatusMatch[1]!);
    return cachedJson(request, `https://admin.internal/api/apps/${encodeURIComponent(appId)}/deploy-status`, 60, () =>
      handleAppDeployStatus(appId, env),
    );
  }

  const healthMatch = url.pathname.match(/^\/api\/apps\/([^/]+)\/health$/);
  if (healthMatch) {
    try {
      return json(await handleAppHealth(decodeURIComponent(healthMatch[1]!), env), 200, request);
    } catch (e) {
      return json({ error: String(e) }, 500, request);
    }
  }

  // VibeCode conversations for this app
  const appSessionsMatch = url.pathname.match(/^\/api\/apps\/([^/]+)\/sessions$/);
  if (appSessionsMatch) {
    try {
      return json(await handleAppSessions(decodeURIComponent(appSessionsMatch[1]!), env), 200, request);
    } catch (e) {
      return json({ error: String(e) }, 500, request);
    }
  }

  return null;
};
