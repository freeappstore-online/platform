import { fetchRegistry, fetchTraffic, UpstreamFetchError } from "../helpers";
import { json } from "../http";
import type { RouteHandler } from "./types";

function errorMessage(reason: unknown): string {
  if (reason instanceof Error) return reason.message;
  return String(reason);
}

function upstreamUnavailable(reason: unknown) {
  return reason instanceof UpstreamFetchError
    ? { message: reason.message, status: reason.status, upstream: reason.upstream }
    : { message: errorMessage(reason), status: 503, upstream: "unknown" };
}

/** GET /api/stats — platform overview counts + 30-day traffic. */
export const statsRoutes: RouteHandler = async ({ request, env, url }) => {
  if (url.pathname !== "/api/stats") return null;
  const [appsReg, gamesReg, userCount, creatorList, traffic, routeCount, sessionCount] = await Promise.allSettled([
    fetchRegistry("apps"),
    fetchRegistry("games"),
    env.DB.prepare("SELECT COUNT(*) as count FROM users").first<{ count: number }>(),
    env.CREATORS.list(),
    fetchTraffic(env),
    env.DB.prepare("SELECT COUNT(*) as count FROM routes").first<{ count: number }>(),
    env.DB.prepare("SELECT COUNT(*) as count FROM agent_sessions").first<{ count: number }>(),
  ]);
  const errors = {
    ...(appsReg.status === "rejected" ? { registryApps: upstreamUnavailable(appsReg.reason) } : {}),
    ...(gamesReg.status === "rejected" ? { registryGames: upstreamUnavailable(gamesReg.reason) } : {}),
  };
  return json(
    {
      apps: appsReg.status === "fulfilled" ? appsReg.value.length : -1,
      games: gamesReg.status === "fulfilled" ? gamesReg.value.length : -1,
      users: userCount.status === "fulfilled" ? userCount.value?.count || 0 : 0,
      creators: creatorList.status === "fulfilled" ? creatorList.value.keys.length : 0,
      routes: routeCount.status === "fulfilled" ? routeCount.value?.count || 0 : 0,
      agentSessions: sessionCount.status === "fulfilled" ? sessionCount.value?.count || 0 : 0,
      traffic: traffic.status === "fulfilled" ? traffic.value : null,
      errors,
    },
    200,
    request,
  );
};
