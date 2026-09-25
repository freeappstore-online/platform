import { json } from "../http";
import type { RouteHandler } from "./types";

/** POST /api/fix-dns — recreate an app's CNAME and host route row. */
export const dnsRoutes: RouteHandler = async ({ request, env, url }) => {
  if (url.pathname !== "/api/fix-dns" || request.method !== "POST") return null;
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
};
