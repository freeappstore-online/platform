// The real host Worker in workerd (#7): a D1 `routes` row maps a hostname to an
// R2 prefix, and reserved subdomains dispatch to service bindings. Real D1 and
// R2; the API/KB Workers and the internet are local stand-ins (vitest.runtime.ts).

import { env, exports } from "cloudflare:workers";
import { beforeAll, describe, expect, it } from "vitest";

const INDEX_HTML = "<!doctype html><title>Dict</title>";
const APP_JS = "console.log('dict')";

const get = (url: string, init?: RequestInit) => exports.default.fetch(new Request(url, init));

beforeAll(async () => {
  const now = Date.now();
  const route = env.DB.prepare(
    "INSERT OR REPLACE INTO routes (slug, zone, r2_prefix, store, hosted_on, created_at, updated_at) VALUES (?, ?, ?, 'apps', 'r2', ?, ?)",
  );
  await env.DB.batch([
    route.bind("dict", "freeappstore.online", "apps/dict", now, now),
    route.bind("agentcoder", "space", "apps/agentcoder", now, now),
  ]);
  await env.APPS.put("apps/dict/index.html", INDEX_HTML);
  await env.APPS.put("apps/dict/assets/app.js", APP_JS);
  await env.APPS.put("apps/agentcoder/index.html", "<!doctype html><title>AgentCoder</title>");
});

describe("serving an app: D1 routes row → R2 object", () => {
  it("serves / from the app's R2 prefix with the platform's security headers", async () => {
    const res = await get("https://dict.freeappstore.online/");
    expect(res.status).toBe(200);
    expect(await res.text()).toBe(INDEX_HTML);
    expect(res.headers.get("content-type")).toMatch(/^text\/html/);
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(res.headers.get("strict-transport-security")).toContain("max-age=31536000");
    expect(res.headers.get("content-security-policy")).toBeTruthy();
    expect(res.headers.get("cache-control")).toBe("public, max-age=60, must-revalidate");
    expect(res.headers.get("etag")).toBeTruthy();
  });

  it("serves assets with their own type and a long immutable cache", async () => {
    const res = await get("https://dict.freeappstore.online/assets/app.js");
    expect(res.status).toBe(200);
    expect(await res.text()).toBe(APP_JS);
    expect(res.headers.get("content-type")).toMatch(/javascript/);
    expect(res.headers.get("cache-control")).toBe("public, max-age=31536000, immutable");
  });

  it("falls back to index.html for client-side routes, but not for missing assets", async () => {
    const route = await get("https://dict.freeappstore.online/word/hello");
    expect(route.status).toBe(200);
    expect(await route.text()).toBe(INDEX_HTML);

    const asset = await get("https://dict.freeappstore.online/assets/missing.js");
    expect(asset.status).toBe(404);
  });

  it("answers 304 to a matching If-None-Match, and HEAD without a body", async () => {
    const first = await get("https://dict.freeappstore.online/assets/app.js");
    const etag = first.headers.get("etag")!;
    await first.body?.cancel();

    const cached = await get("https://dict.freeappstore.online/assets/app.js", { headers: { "if-none-match": etag } });
    expect(cached.status).toBe(304);
    expect(await cached.text()).toBe("");

    const head = await get("https://dict.freeappstore.online/assets/app.js", { method: "HEAD" });
    expect(head.status).toBe(200);
    expect(head.headers.get("etag")).toBe(etag);
    expect(await head.text()).toBe("");
  });

  it("refuses writes to an app", async () => {
    const res = await get("https://dict.freeappstore.online/", { method: "POST", body: "x" });
    expect(res.status).toBe(405);
    expect(res.headers.get("allow")).toBe("GET, HEAD");
  });

  it("404s a hostname with no routes row", async () => {
    const res = await get("https://nobody.freeappstore.online/");
    expect(res.status).toBe(404);
    expect(await res.text()).toContain("no app registered at nobody.freeappstore.online");
  });

  it("generates robots.txt and sitemap.xml for an app", async () => {
    const robots = await get("https://dict.freeappstore.online/robots.txt");
    expect(robots.status).toBe(200);
    expect(robots.headers.get("content-type")).toMatch(/^text\/plain/);
    expect(await robots.text()).toContain("https://dict.freeappstore.online/sitemap.xml");

    const sitemap = await get("https://dict.freeappstore.online/sitemap.xml");
    expect(sitemap.headers.get("content-type")).toMatch(/^application\/xml/);
  });
});

describe("custom domains", () => {
  it("serves a custom domain from its own routes row", async () => {
    const res = await get("https://agentcoder.space/");
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("AgentCoder");
  });

  it("redirects www to the apex, but serves www crawl files directly", async () => {
    const www = await get("https://www.agentcoder.space/docs?x=1", { redirect: "manual" });
    expect(www.status).toBe(301);
    expect(www.headers.get("location")).toBe("https://agentcoder.space/docs?x=1");

    const robots = await get("https://www.agentcoder.space/robots.txt");
    expect(robots.status).toBe(200);
    expect(await robots.text()).toContain("https://agentcoder.space/sitemap.xml");
  });
});

describe("reserved platform subdomains", () => {
  it("dispatches api.* to the API service binding, unchanged", async () => {
    const res = await get("https://api.freeappstore.online/v1/health?x=1", { method: "POST", body: "{}" });
    expect(await res.json()).toMatchObject({ binding: "API", url: "https://api.freeappstore.online/v1/health?x=1", method: "POST" });
  });

  it("dispatches docs.* and kb.* to the KB service binding", async () => {
    expect(await (await get("https://docs.freeappstore.online/guide")).json()).toMatchObject({ binding: "KB" });
    expect(await (await get("https://kb.freeappstore.online/")).json()).toMatchObject({ binding: "KB" });
  });

  it("proxies compliance.* to its Pages project, keeping the path", async () => {
    const res = await get("https://compliance.freeappstore.online/report?app=dict");
    expect(await res.json()).toEqual({ outbound: "https://compliance.pages.dev/report?app=dict", method: "GET" });
  });

  it("301s the retired create.* builder to the console, keeping the path", async () => {
    const res = await get("https://create.freeappstore.online/app/abc", { redirect: "manual" });
    expect(res.status).toBe(301);
    expect(res.headers.get("location")).toBe("https://freeappstore.online/app/build/app/abc");
  });

  it("answers auth.* with a clean 404, not a 502", async () => {
    const res = await get("https://auth.freeappstore.online/");
    expect(res.status).toBe(404);
    expect(await res.text()).toContain("not a web service");
  });

  it("does not treat a custom domain's api.* as the platform API", async () => {
    const res = await get("https://api.agentcoder.space/");
    expect(res.status).toBe(404);
  });
});
