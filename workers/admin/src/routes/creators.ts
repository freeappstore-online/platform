import type { Env } from "../helpers";
import { json, parseJsonObject } from "../http";
import type { RouteHandler } from "./types";

/** GET /api/users (paged D1 users) and GET /api/creators (CREATORS KV). */
export const creatorsRoutes: RouteHandler = async ({ request, env, url }) => {
  if (url.pathname === "/api/users") return users(request, env, url);
  if (url.pathname === "/api/creators") return creators(request, env);
  return null;
};

async function users(request: Request, env: Env, url: URL): Promise<Response> {
  try {
    const page = Math.max(1, parseInt(url.searchParams.get("page") || "1", 10) || 1);
    const limit = 50;
    const offset = (page - 1) * limit;
    const [rows, total] = await Promise.all([
      env.DB.prepare(
        "SELECT id, github_login, display_name, email, avatar_url, provider, created_at FROM users ORDER BY created_at DESC LIMIT ? OFFSET ?",
      )
        .bind(limit, offset)
        .all(),
      env.DB.prepare("SELECT COUNT(*) as count FROM users").first<{ count: number }>(),
    ]);
    const users = (rows.results ?? []).map((u: any) => ({
      ...u,
      name: u.display_name || u.github_login || u.id,
      email: u.email || "",
      photo_url: u.avatar_url || null,
      provider: u.provider || "github",
    }));
    return json({ users, total: total?.count || 0, page, pages: Math.ceil((total?.count || 0) / limit) }, 200, request);
  } catch {
    return json({ error: "Internal server error", users: [], total: 0, page: 1, pages: 0 }, 500, request);
  }
}

async function creators(request: Request, env: Env): Promise<Response> {
  const list = await env.CREATORS.list();
  const creators = await Promise.all(
    list.keys.map(async (k) => {
      const raw = await env.CREATORS.get(k.name);
      if (!raw) return null;
      const data = parseJsonObject(raw);
      if (!data) return null;
      return { github: data.github, apps: data.apps, banned: data.banned, maxApps: data.maxApps };
    }),
  );
  return json(creators.filter(Boolean), 200, request);
}
