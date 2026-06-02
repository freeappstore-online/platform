import {
  type AppConfig,
  type Env,
  fetchRegistry,
  fetchTraffic,
  handleAgentSessionDetail,
  handleAgentSessions,
  handleAppHealth,
  handleAppSessions,
  handleAppsAll,
} from "./helpers";
import { handlePublish } from "./publish";

export type { AppConfig, Env };

// ── CORS ──

function corsHeaders(request: Request): Record<string, string> {
  const origin = request.headers.get("Origin");
  const allowed =
    origin && (origin.endsWith(".freeappstore.online") || origin === "https://freeappstore.online" || origin.startsWith("http://localhost"))
      ? origin
      : "https://freeappstore.online";
  return {
    "Access-Control-Allow-Origin": allowed,
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Allow-Credentials": "true",
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "strict-origin-when-cross-origin",
    "X-Frame-Options": "DENY",
  };
}

// ── JWT verification ──

function base64UrlDecode(str: string): Uint8Array {
  let b64 = str.replace(/-/g, "+").replace(/_/g, "/");
  while (b64.length % 4 !== 0) b64 += "=";
  return Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
}

let cachedCerts: { keys: JsonWebKey[]; at: number } | null = null;

async function fetchAccessCerts(teamDomain: string): Promise<JsonWebKey[]> {
  if (cachedCerts && Date.now() - cachedCerts.at < 3600_000) return cachedCerts.keys;
  const res = await fetch(`https://${teamDomain}/cdn-cgi/access/certs`);
  if (!res.ok) throw new Error("Failed to fetch CF Access certs");
  const data = (await res.json()) as { keys: JsonWebKey[] };
  cachedCerts = { keys: data.keys, at: Date.now() };
  return data.keys;
}

async function verifyAccessJwt(jwt: string, teamDomain: string, aud: string): Promise<boolean> {
  try {
    const [headerB64, payloadB64, sigB64] = jwt.split(".");
    if (!headerB64 || !payloadB64 || !sigB64) return false;
    const header = JSON.parse(new TextDecoder().decode(base64UrlDecode(headerB64)));
    const payload = JSON.parse(new TextDecoder().decode(base64UrlDecode(payloadB64)));
    if (!payload.aud?.includes(aud)) return false;
    if (payload.exp && payload.exp < Date.now() / 1000) return false;
    const certs = await fetchAccessCerts(teamDomain);
    const jwk = certs.find((k: any) => k.kid === header.kid);
    if (!jwk) return false;
    const key = await crypto.subtle.importKey("jwk", jwk, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["verify"]);
    const data = new TextEncoder().encode(`${headerB64}.${payloadB64}`);
    return crypto.subtle.verify("RSASSA-PKCS1-v1_5", key, base64UrlDecode(sigB64) as BufferSource, data);
  } catch {
    return false;
  }
}

async function isAuthenticated(request: Request, env: Env): Promise<boolean> {
  // CF Access not configured (local dev / test) — allow all requests.
  // In production, CF_ACCESS_TEAM_DOMAIN + CF_ACCESS_AUD are always set.
  if (!env.CF_ACCESS_TEAM_DOMAIN && !env.CF_ACCESS_AUD) return true;
  const jwt = request.headers.get("Cf-Access-Jwt-Assertion");
  if (!jwt) return false;
  return verifyAccessJwt(jwt, env.CF_ACCESS_TEAM_DOMAIN, env.CF_ACCESS_AUD);
}

// ── Helpers ──

function json(data: unknown, status: number, request: Request) {
  return new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json", ...corsHeaders(request) } });
}

// ── Worker ──

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: corsHeaders(request) });

    const url = new URL(request.url);

    // CI uploads test reports with X-CI-Token and has no browser/CF Access JWT,
    // so let that single path through before the CF Access gate. Without this
    // the gate 401s it and the in-handler CI-token branch is unreachable.
    const isCiTestReport =
      url.pathname === "/api/test-report" &&
      request.method === "PUT" &&
      !!env.CI_TOKEN &&
      request.headers.get("X-CI-Token") === env.CI_TOKEN;

    if (!isCiTestReport && !(await isAuthenticated(request, env))) return json({ error: "Unauthorized" }, 401, request);

    // ── Provision ──

    if (url.pathname === "/api/provision" && request.method === "POST") {
      const provJwt = request.headers.get("Cf-Access-Jwt-Assertion");
      if (provJwt) {
        try {
          const provPayload = JSON.parse(atob(provJwt.split(".")[1]!));
          const provEmail = provPayload.email || provPayload.sub || "";
          const provUser = provEmail.includes("@") ? provEmail.split("@")[0]! : provEmail;
          if (provUser) {
            const rlKey = `ratelimit:${provUser}:provision`;
            const rlRaw = await env.CREATORS.get(rlKey);
            if (rlRaw && parseInt(rlRaw) >= 3) return json({ error: "Rate limit: max 3 provisions per hour" }, 429, request);
            await env.CREATORS.put(rlKey, String((rlRaw ? parseInt(rlRaw) : 0) + 1), { expirationTtl: 3600 });
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
        });
        return json(result, result.success ? 200 : 400, request);
      } catch (e) {
        const detail = e instanceof Error ? `${e.name}: ${e.message}` : String(e);
        return json({ error: "Provisioning failed", detail }, 500, request);
      }
    }

    // ── Unpublish ──

    if (url.pathname === "/api/unpublish" && request.method === "POST") {
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
            content: btoa(JSON.stringify(registry, null, 2) + "\n"),
            sha: regFile.sha,
          }),
        });
        return json({ ok: updateRes.ok, id: body.id }, updateRes.ok ? 200 : 500, request);
      } catch (e) {
        return json({ error: String(e) }, 500, request);
      }
    }

    // ── Deprovision ──

    if (url.pathname === "/api/deprovision" && request.method === "POST") {
      try {
        const body = (await request.json()) as { id: string; store: "apps" | "games"; deleteRepo?: boolean };
        if (!body.id || !body.store) return json({ error: "id and store required" }, 400, request);
        const steps: { name: string; status: string; detail: string }[] = [];
        try {
          const unpubRes = await fetch(new URL("/api/unpublish", request.url).toString(), {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ id: body.id, store: body.store }),
          });
          steps.push({ name: "registry", status: unpubRes.ok ? "ok" : "skip", detail: unpubRes.ok ? "Removed" : "Not in registry" });
        } catch (e) {
          steps.push({ name: "registry", status: "fail", detail: String(e) });
        }
        // Delete hosting route from D1
        try {
          const domain = body.store === "apps" ? "freeappstore.online" : "freegamestore.online";
          await env.DB.prepare("DELETE FROM routes WHERE slug = ? AND zone = ?").bind(body.id, domain).run();
          steps.push({ name: "hosting_route", status: "ok", detail: "Route deleted" });
        } catch (e) {
          steps.push({ name: "hosting_route", status: "fail", detail: String(e) });
        }
        // Purge the app's R2 objects so storage isn't orphaned after delisting.
        try {
          if (env.APPS) {
            const prefix = `${body.store}/${body.id}/`; // apps/<id>/ or games/<id>/
            let deleted = 0;
            let cursor: string | undefined;
            do {
              const listed = await env.APPS.list({ prefix, cursor });
              if (listed.objects.length > 0) {
                await env.APPS.delete(listed.objects.map((o) => o.key));
                deleted += listed.objects.length;
              }
              cursor = listed.truncated ? listed.cursor : undefined;
            } while (cursor);
            steps.push({ name: "r2_objects", status: "ok", detail: `${deleted} object(s) under ${prefix}` });
          } else {
            steps.push({ name: "r2_objects", status: "skip", detail: "R2 binding (APPS) not available" });
          }
        } catch (e) {
          steps.push({ name: "r2_objects", status: "fail", detail: String(e) });
        }
        const meta =
          body.store === "apps"
            ? { zone: env.FAS_ZONE_ID, domain: "freeappstore.online" }
            : { zone: env.FGS_ZONE_ID, domain: "freegamestore.online" };
        try {
          const dnsListRes = await fetch(
            `https://api.cloudflare.com/client/v4/zones/${meta.zone}/dns_records?type=CNAME&name=${body.id}.${meta.domain}`,
            { headers: { Authorization: `Bearer ${env.CF_API_TOKEN}` } },
          );
          const dnsList = (await dnsListRes.json()) as any;
          for (const rec of dnsList.result ?? []) {
            await fetch(`https://api.cloudflare.com/client/v4/zones/${meta.zone}/dns_records/${rec.id}`, {
              method: "DELETE",
              headers: { Authorization: `Bearer ${env.CF_API_TOKEN}` },
            });
          }
          steps.push({ name: "dns", status: "ok", detail: `${(dnsList.result ?? []).length} record(s) deleted` });
        } catch (e) {
          steps.push({ name: "dns", status: "fail", detail: String(e) });
        }
        if (body.deleteRepo) {
          const org = body.store === "apps" ? "freeappstore-online" : "freegamestore-online";
          try {
            const ghDel = await fetch(`https://api.github.com/repos/${org}/${body.id}`, {
              method: "DELETE",
              headers: {
                Authorization: `Bearer ${env.GITHUB_TOKEN}`,
                Accept: "application/vnd.github+json",
                "User-Agent": "freeappstore-admin",
              },
            });
            steps.push({
              name: "delete_repo",
              status: ghDel.ok || ghDel.status === 404 ? "ok" : "fail",
              detail: ghDel.ok ? "Deleted" : `HTTP ${ghDel.status}`,
            });
          } catch (e) {
            steps.push({ name: "delete_repo", status: "fail", detail: String(e) });
          }
        }
        return json({ ok: true, id: body.id, steps }, 200, request);
      } catch (e) {
        return json({ error: "Deprovision failed" }, 500, request);
      }
    }

    // ── Stats ──

    if (url.pathname === "/api/stats") {
      const [appsReg, gamesReg, userCount, creatorList, traffic, routeCount, sessionCount] = await Promise.allSettled([
        fetchRegistry("apps"),
        fetchRegistry("games"),
        env.DB.prepare("SELECT COUNT(*) as count FROM users").first<{ count: number }>(),
        env.CREATORS.list(),
        fetchTraffic(env),
        env.DB.prepare("SELECT COUNT(*) as count FROM routes").first<{ count: number }>(),
        env.DB.prepare("SELECT COUNT(*) as count FROM agent_sessions").first<{ count: number }>(),
      ]);
      return json(
        {
          apps: appsReg.status === "fulfilled" ? appsReg.value.length : 0,
          games: gamesReg.status === "fulfilled" ? gamesReg.value.length : 0,
          users: userCount.status === "fulfilled" ? userCount.value?.count || 0 : 0,
          creators: creatorList.status === "fulfilled" ? creatorList.value.keys.length : 0,
          routes: routeCount.status === "fulfilled" ? routeCount.value?.count || 0 : 0,
          agentSessions: sessionCount.status === "fulfilled" ? sessionCount.value?.count || 0 : 0,
          traffic: traffic.status === "fulfilled" ? traffic.value : null,
        },
        200,
        request,
      );
    }

    // ── Users / Creators ──

    if (url.pathname === "/api/users") {
      try {
        const page = Math.max(1, parseInt(url.searchParams.get("page") || "1") || 1);
        const limit = 50;
        const offset = (page - 1) * limit;
        const [rows, total] = await Promise.all([
          env.DB.prepare("SELECT id, github_login, avatar_url, created_at FROM users ORDER BY created_at DESC LIMIT ? OFFSET ?")
            .bind(limit, offset)
            .all(),
          env.DB.prepare("SELECT COUNT(*) as count FROM users").first<{ count: number }>(),
        ]);
        return json({ users: rows.results, total: total?.count || 0, page, pages: Math.ceil((total?.count || 0) / limit) }, 200, request);
      } catch {
        return json({ error: "Internal server error", users: [], total: 0, page: 1, pages: 0 }, 500, request);
      }
    }

    if (url.pathname === "/api/creators") {
      const list = await env.CREATORS.list();
      const creators = await Promise.all(
        list.keys.map(async (k) => {
          const raw = await env.CREATORS.get(k.name);
          if (!raw) return null;
          const data = JSON.parse(raw);
          return { github: data.github, apps: data.apps, banned: data.banned, maxApps: data.maxApps };
        }),
      );
      return json(creators.filter(Boolean), 200, request);
    }

    // ── Test reports ──

    if (url.pathname === "/test-report") {
      const html = await env.CREATORS.get("report:test-report:latest");
      if (!html) return new Response("No test report available yet.", { status: 404 });
      return new Response(html, { headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-cache" } });
    }

    if (url.pathname === "/api/test-report" && request.method === "PUT") {
      const ciToken = request.headers.get("X-CI-Token");
      if ((!env.CI_TOKEN || ciToken !== env.CI_TOKEN) && !request.headers.get("Cf-Access-Jwt-Assertion")) {
        return json({ error: "Unauthorized" }, 401, request);
      }
      const body = await request.text();
      if (!body || body.length < 100) return json({ error: "Report body required" }, 400, request);
      if (body.length > 512_000) return json({ error: "Report too large (max 512KB)" }, 413, request);
      await env.CREATORS.put("report:test-report:latest", body);
      await env.CREATORS.put("report:test-report:updated", new Date().toISOString());
      return json({ ok: true, size: body.length }, 200, request);
    }

    // ── Fix DNS ──

    if (url.pathname === "/api/fix-dns" && request.method === "POST") {
      try {
        const body = (await request.json()) as { id: string; store: "apps" | "games" };
        if (!body.id || !body.store) return json({ error: "id and store required" }, 400, request);
        const meta =
          body.store === "apps"
            ? { zone: env.FAS_ZONE_ID, domain: "freeappstore.online" }
            : { zone: env.FGS_ZONE_ID, domain: "freegamestore.online" };
        const steps: { name: string; status: string; detail: string }[] = [];
        // CNAME pointing at the host worker (proxied — CF terminates TLS)
        const cnameRes = await fetch(`https://api.cloudflare.com/client/v4/zones/${meta.zone}/dns_records`, {
          method: "POST",
          headers: { Authorization: `Bearer ${env.CF_API_TOKEN}`, "Content-Type": "application/json" },
          body: JSON.stringify({ type: "CNAME", name: `${body.id}.${meta.domain}`, content: meta.domain, proxied: true }),
        });
        const cnameData = (await cnameRes.json()) as any;
        steps.push({
          name: "CNAME",
          status: cnameData.success ? "ok" : "fail",
          detail: cnameData.success ? `${body.id}.${meta.domain}` : cnameData.errors?.[0]?.message || "Failed",
        });
        // Path B: ensure the host route row exists too — the DNS record alone
        // doesn't make the host serve; freeappstore-host needs the routes row.
        try {
          const r2Prefix = `${body.store}/${body.id}`;
          const now = Date.now();
          await env.DB.prepare(
            `INSERT INTO routes (slug, zone, r2_prefix, store, hosted_on, created_at, updated_at)
             VALUES (?1, ?2, ?3, ?4, 'r2', ?5, ?5)
             ON CONFLICT (slug, zone) DO UPDATE SET
               r2_prefix = excluded.r2_prefix,
               store = excluded.store,
               hosted_on = excluded.hosted_on,
               updated_at = excluded.updated_at`,
          )
            .bind(body.id, meta.domain, r2Prefix, body.store, now)
            .run();
          steps.push({
            name: "host_route",
            status: "ok",
            detail: `${body.id}.${meta.domain} → r2://${body.store === "apps" ? "fas-apps" : "fgs-games"}/${r2Prefix}`,
          });
        } catch (e) {
          steps.push({ name: "host_route", status: "fail", detail: String(e) });
        }
        return json({ ok: steps.every((s) => s.status !== "fail"), steps }, 200, request);
      } catch (e) {
        return json({ error: "Fix DNS failed", detail: String(e) }, 500, request);
      }
    }

    // ── Unified apps (R2 + registry + D1) ──

    if (url.pathname === "/api/apps/all") {
      try {
        return json(await handleAppsAll(env), 200, request);
      } catch (e) {
        return json({ error: "Internal error", detail: String(e) }, 500, request);
      }
    }

    // ── App health ──

    const healthMatch = url.pathname.match(/^\/api\/apps\/([^/]+)\/health$/);
    if (healthMatch) {
      try {
        return json(await handleAppHealth(decodeURIComponent(healthMatch[1]!), env), 200, request);
      } catch (e) {
        return json({ error: String(e) }, 500, request);
      }
    }

    // ── App sessions (VibeCode conversations for this app) ──

    const appSessionsMatch = url.pathname.match(/^\/api\/apps\/([^/]+)\/sessions$/);
    if (appSessionsMatch) {
      try {
        return json(await handleAppSessions(decodeURIComponent(appSessionsMatch[1]!), env), 200, request);
      } catch (e) {
        return json({ error: String(e) }, 500, request);
      }
    }

    // ── Agent sessions ──

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

    // ── Fallback ──

    if (url.pathname.startsWith("/api/")) return json({ error: "not found" }, 404, request);
    return new Response(null, { status: 404 });
  },
};
