import { describe, expect, it } from "vitest";
import {
  contentType,
  crawlAssetResponse,
  etagsMatch,
  isImmutablePath,
  type Route,
  r2KeyFor,
  resolveRoute,
  robotsTxtFor,
  securityHeaders,
  sitemapXmlFor,
  wantsCrossOriginIsolation,
} from "../host";

describe("authored crawl file responses", () => {
  const object = (body: string) => ({ body: new Response(body).body, httpEtag: '"crawl-v1"' }) as R2ObjectBody;
  it.each([
    ["/robots.txt", "text/plain"],
    ["/sitemap.xml", "application/xml"],
  ])("preserves %s with its MIME type, security and revalidating cache", async (path, type) => {
    const response = crawlAssetResponse(object("authored content"), path, "GET", null);
    expect(await response.text()).toBe("authored content");
    expect(response.headers.get("content-type")).toBe(`${type}; charset=utf-8`);
    expect(response.headers.get("cache-control")).toBe("public, max-age=60, must-revalidate");
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(response.headers.get("etag")).toBe('"crawl-v1"');
  });
  it("answers HEAD and conditional requests without transferring an authored body", async () => {
    const head = crawlAssetResponse(object("authored content"), "/sitemap.xml", "HEAD", null);
    expect(head.status).toBe(200);
    expect(await head.text()).toBe("");
    const cached = crawlAssetResponse(object("authored content"), "/sitemap.xml", "GET", 'W/"crawl-v1"');
    expect(cached.status).toBe(304);
    expect(await cached.text()).toBe("");
    expect(cached.headers.get("etag")).toBe('"crawl-v1"');
  });

  it("forwards COOP/COEP onto authored crawl files only when the app opted in", async () => {
    const plain = crawlAssetResponse(object("authored content"), "/robots.txt", "GET", null);
    expect(plain.headers.get("cross-origin-opener-policy")).toBeNull();
    const iso = crawlAssetResponse(object("authored content"), "/robots.txt", "GET", null, { crossOriginIsolated: true });
    expect(iso.headers.get("cross-origin-opener-policy")).toBe("same-origin");
    expect(iso.headers.get("cross-origin-embedder-policy")).toBe("credentialless");
  });
});

// Minimal D1 stub — verifies the SQL shape and parameter binding without
// spinning up a real D1. Real schema integration is exercised by the
// migration apply step + an end-to-end test against a deployed Worker.
function mockDb(rows: Route[]): D1Database {
  return {
    prepare: (_sql: string) => ({
      bind: (slug: string, zone: string) => ({
        first: async () => rows.find((r) => r.slug === slug && r.zone === zone) ?? null,
      }),
    }),
  } as unknown as D1Database;
}

const kanban: Route = { slug: "kanban", zone: "freeappstore.online", r2_prefix: "apps/kanban", store: "apps" };

describe("resolveRoute", () => {
  it("resolves a known subdomain", async () => {
    const r = await resolveRoute(mockDb([kanban]), "kanban.freeappstore.online");
    expect(r?.r2_prefix).toBe("apps/kanban");
  });

  it("returns null for unknown subdomain", async () => {
    expect(await resolveRoute(mockDb([kanban]), "missing.freeappstore.online")).toBeNull();
  });

  it("handles uppercase host", async () => {
    expect(await resolveRoute(mockDb([kanban]), "Kanban.FreeAppStore.Online")).not.toBeNull();
  });

  it("strips port suffix", async () => {
    expect(await resolveRoute(mockDb([kanban]), "kanban.freeappstore.online:8443")).not.toBeNull();
  });

  it("returns null for apex (no subdomain)", async () => {
    expect(await resolveRoute(mockDb([kanban]), "freeappstore.online")).toBeNull();
  });

  it("returns null for empty host", async () => {
    expect(await resolveRoute(mockDb([kanban]), "")).toBeNull();
  });

  it("matches the right slug+zone among multiple rows", async () => {
    const games: Route = { slug: "kanban", zone: "freegamestore.online", r2_prefix: "games/kanban", store: "games" };
    const db = mockDb([kanban, games]);
    expect((await resolveRoute(db, "kanban.freeappstore.online"))?.r2_prefix).toBe("apps/kanban");
    expect((await resolveRoute(db, "kanban.freegamestore.online"))?.r2_prefix).toBe("games/kanban");
  });

  it("returns the isolation flag stored on the route", async () => {
    const flagged: Route = { ...kanban, slug: "wasm", r2_prefix: "apps/wasm", cross_origin_isolated: 1 };
    const row = await resolveRoute(mockDb([flagged]), "wasm.freeappstore.online");
    expect(row?.cross_origin_isolated).toBe(1);
    expect(wantsCrossOriginIsolation(row!)).toBe(true);
  });
});

describe("r2KeyFor", () => {
  it("defaults / to index.html", () => {
    expect(r2KeyFor(kanban, "/")).toBe("apps/kanban/index.html");
  });

  it("decodes percent-encoded paths to the literal uploaded filename", () => {
    expect(r2KeyFor(kanban, "/my%20photo.png")).toBe("apps/kanban/my photo.png");
    expect(r2KeyFor(kanban, "/caf%C3%A9.svg")).toBe("apps/kanban/café.svg");
  });

  it("leaves a malformed escape as-is", () => {
    expect(r2KeyFor(kanban, "/100%.png")).toBe("apps/kanban/100%.png");
  });

  it("defaults directory paths to index.html", () => {
    expect(r2KeyFor(kanban, "/about/")).toBe("apps/kanban/about/index.html");
  });

  it("strips leading slash", () => {
    expect(r2KeyFor(kanban, "/static/app.js")).toBe("apps/kanban/static/app.js");
  });

  it("does not append index.html for files with extensions", () => {
    expect(r2KeyFor(kanban, "/style.css")).toBe("apps/kanban/style.css");
  });
});

describe("contentType", () => {
  it.each([
    ["/index.html", "text/html; charset=utf-8"],
    ["/app.js", "application/javascript; charset=utf-8"],
    ["/app.mjs", "application/javascript; charset=utf-8"],
    ["/style.css", "text/css; charset=utf-8"],
    ["/logo.svg", "image/svg+xml"],
    ["/icon.png", "image/png"],
    ["/photo.jpg", "image/jpeg"],
    ["/font.woff2", "font/woff2"],
    ["/site.webmanifest", "application/manifest+json"],
    ["/binary.bin", "application/octet-stream"],
    ["/no-extension", "application/octet-stream"],
  ])("%s → %s", (path, expected) => {
    expect(contentType(path)).toBe(expected);
  });

  // Regression: a URL pathname of "/" has no extension and would resolve to
  // octet-stream; the Worker now feeds contentType the resolved R2 key
  // (apps/<slug>/index.html), which correctly resolves to text/html. This
  // matters because X-Content-Type-Options: nosniff turns octet-stream into
  // a download prompt instead of rendering.
  it("resolves text/html from a key built by r2KeyFor for `/`", () => {
    expect(contentType(r2KeyFor(kanban, "/"))).toBe("text/html; charset=utf-8");
  });

  it("resolves text/html from a key built for a directory path", () => {
    expect(contentType(r2KeyFor(kanban, "/about/"))).toBe("text/html; charset=utf-8");
  });
});

// ---- Security headers: defense-in-depth baseline applied to every app. ----
// The analytics pipeline (loader, beacon, BYO tags) depends on these directives
// being permissive enough to allow the platform origins. A future tightening
// pass that drops the broad `https:` from script-src + connect-src must keep
// the explicit api.freeappstore.online / cloudflareinsights / googletagmanager /
// plausible.io origins or analytics breaks across every app.

describe("securityHeaders", () => {
  const html = securityHeaders({ htmlCache: true });
  const asset = securityHeaders({ htmlCache: false });

  it("HTML gets short cache, assets get immutable cache", () => {
    expect(html.get("cache-control")).toContain("max-age=60");
    expect(html.get("cache-control")).toContain("must-revalidate");
    expect(asset.get("cache-control")).toContain("max-age=31536000");
    expect(asset.get("cache-control")).toContain("immutable");
  });

  it("CSP allows the platform analytics loader endpoint", () => {
    const csp = html.get("content-security-policy") ?? "";
    expect(csp).toContain("https://api.freeappstore.online");
    expect(csp).toMatch(/script-src[^;]*https:\/\/api\.freeappstore\.online/);
    expect(csp).toMatch(/connect-src[^;]*https:\/\/api\.freeappstore\.online/);
  });

  it("CSP allows CF Web Analytics beacon (cookieless first-party)", () => {
    const csp = html.get("content-security-policy") ?? "";
    expect(csp).toContain("https://static.cloudflareinsights.com");
    expect(csp).toContain("https://cloudflareinsights.com");
  });

  it("CSP allows BYO Google Analytics 4 tags", () => {
    const csp = html.get("content-security-policy") ?? "";
    expect(csp).toContain("https://www.googletagmanager.com");
    expect(csp).toContain("https://www.google-analytics.com");
  });

  it("CSP allows BYO Plausible tags", () => {
    const csp = html.get("content-security-policy") ?? "";
    expect(csp).toContain("https://plausible.io");
  });

  it("CSP locks down object-src and base-uri (defense-in-depth)", () => {
    const csp = html.get("content-security-policy") ?? "";
    expect(csp).toMatch(/object-src 'none'/);
    expect(csp).toMatch(/base-uri 'self'/);
  });

  it("frame-ancestors allows storefront preview iframes only", () => {
    const csp = html.get("content-security-policy") ?? "";
    expect(csp).toContain("frame-ancestors 'self' https://freeappstore.online");
    expect(csp).not.toContain("pages.dev");
    expect(csp).toContain("https://*.freeappstore.online");
  });

  it("upgrades insecure requests + sets HSTS", () => {
    expect(html.get("content-security-policy")).toContain("upgrade-insecure-requests");
    expect(html.get("strict-transport-security")).toMatch(/max-age=\d+/);
    expect(html.get("strict-transport-security")).toContain("includeSubDomains");
  });

  // #284 default-open: every feature on the app's own origin, one written block.
  it.each([
    "accelerometer",
    "ambient-light-sensor",
    "autoplay",
    "bluetooth",
    "camera",
    "clipboard-read",
    "clipboard-write",
    "display-capture",
    "encrypted-media",
    "fullscreen",
    "gamepad",
    "geolocation",
    "gyroscope",
    "hid",
    "idle-detection",
    "local-fonts",
    "magnetometer",
    "microphone",
    "midi",
    "picture-in-picture",
    "publickey-credentials-create",
    "publickey-credentials-get",
    "screen-wake-lock",
    "serial",
    "storage-access",
    "usb",
    "web-share",
    "window-management",
    "xr-spatial-tracking",
  ])("Permissions-Policy grants %s to the app's own origin", (feature) => {
    const entries = (html.get("permissions-policy") ?? "").split(", ");
    expect(entries).toContain(`${feature}=(self)`);
  });

  it("Permissions-Policy blocks only the Topics API (no tracking) and payments (#289)", () => {
    const entries = (html.get("permissions-policy") ?? "").split(", ");
    expect(entries.filter((e) => e.endsWith("=()"))).toEqual(["browsing-topics=()", "payment=()"]);
    expect(entries).not.toContain("payment=(self)");
    // interest-cohort (FLoC) is unrecognised by current Chrome and logged a
    // console error on every page load.
    expect(entries.some((e) => e.startsWith("interest-cohort"))).toBe(false);
  });

  // #284: same-origin blob:/data: URLs and WebAssembly must work.
  it("CSP allows WebAssembly, Blob-URL workers and blob:/data: fetches", () => {
    const csp = html.get("content-security-policy") ?? "";
    const directive = (name: string) => csp.split("; ").find((d) => d.startsWith(`${name} `)) ?? "";
    expect(directive("script-src")).toContain("'wasm-unsafe-eval'");
    expect(directive("script-src")).toContain("blob:");
    expect(directive("worker-src")).toBe("worker-src 'self' blob: https:");
    expect(directive("connect-src")).toContain("data:");
    expect(directive("connect-src")).toContain("blob:");
    expect(directive("connect-src")).toContain("wss:");
  });

  it("sets nosniff + strict referrer policy", () => {
    expect(html.get("x-content-type-options")).toBe("nosniff");
    expect(html.get("referrer-policy")).toBe("strict-origin-when-cross-origin");
  });

  // #286: isolation is opt-in. Default apps must not send COOP/COEP, or
  // third-party images, embeds and window.opener break for everyone.
  it("does not send COOP/COEP or cross-origin-isolated by default", () => {
    expect(html.get("cross-origin-opener-policy")).toBeNull();
    expect(html.get("cross-origin-embedder-policy")).toBeNull();
    expect(html.get("permissions-policy")).not.toContain("cross-origin-isolated");
    expect(asset.get("cross-origin-opener-policy")).toBeNull();
    expect(asset.get("cross-origin-embedder-policy")).toBeNull();
  });

  it("sends COOP/COEP and Permissions-Policy isolation only when opted in", () => {
    const iso = securityHeaders({ htmlCache: true, crossOriginIsolated: true });
    expect(iso.get("cross-origin-opener-policy")).toBe("same-origin");
    expect(iso.get("cross-origin-embedder-policy")).toBe("credentialless");
    const entries = (iso.get("permissions-policy") ?? "").split(", ");
    expect(entries).toContain("cross-origin-isolated=(self)");
    expect(entries.filter((e) => e.endsWith("=()"))).toEqual(["browsing-topics=()", "payment=()"]);
    // Other default-open grants stay in place.
    expect(entries).toContain("microphone=(self)");
    expect(entries).toContain("camera=(self)");
  });
});

describe("wantsCrossOriginIsolation", () => {
  it("is off for missing, 0, or junk values", () => {
    expect(wantsCrossOriginIsolation({})).toBe(false);
    expect(wantsCrossOriginIsolation({ cross_origin_isolated: 0 })).toBe(false);
    expect(wantsCrossOriginIsolation({ cross_origin_isolated: 2 })).toBe(false);
  });

  it("is on only for the integer 1 stored on the route", () => {
    expect(wantsCrossOriginIsolation({ cross_origin_isolated: 1 })).toBe(true);
  });
});

describe("etagsMatch (304 Not Modified)", () => {
  it("returns false when no If-None-Match header is sent", () => {
    expect(etagsMatch(null, '"abc"')).toBe(false);
  });

  it("matches a single quoted etag exactly", () => {
    expect(etagsMatch('"abc"', '"abc"')).toBe(true);
    expect(etagsMatch('"abc"', '"def"')).toBe(false);
  });

  it("matches against a comma-separated list", () => {
    expect(etagsMatch('"abc", "def", "ghi"', '"def"')).toBe(true);
    expect(etagsMatch('"abc", "def"', '"xyz"')).toBe(false);
  });

  it("wildcard * matches any etag", () => {
    expect(etagsMatch("*", '"anything"')).toBe(true);
  });

  it("trims whitespace around list entries", () => {
    expect(etagsMatch('  "abc"  ,  "def"  ', '"def"')).toBe(true);
  });

  it("treats empty header as no-match", () => {
    expect(etagsMatch("", '"abc"')).toBe(false);
    expect(etagsMatch("   ", '"abc"')).toBe(false);
  });
});

describe("generated crawl documents", () => {
  it("builds robots.txt with a matching sitemap URL", () => {
    expect(robotsTxtFor("https://agentcoder.space")).toBe(`User-agent: *
Allow: /

Sitemap: https://agentcoder.space/sitemap.xml
`);
  });

  it("builds a minimal sitemap for the current app origin", () => {
    const xml = sitemapXmlFor("https://agentcoder.space");
    expect(xml).toContain('<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">');
    expect(xml).toContain("<loc>https://agentcoder.space/</loc>");
  });

  it("escapes XML-sensitive origin characters defensively", () => {
    expect(sitemapXmlFor("https://example.com/?a=1&b=2")).toContain("<loc>https://example.com/?a=1&amp;b=2/</loc>");
  });
});

describe("isImmutablePath", () => {
  it("is true only for Vite's hashed /assets/ output", () => {
    expect(isImmutablePath("/assets/index-3f9a1c.js")).toBe(true);
    for (const p of ["/manifest.json", "/sw.js", "/icon-192.png", "/favicon.svg", "/", "/assetsx/a.js"]) {
      expect(isImmutablePath(p)).toBe(false);
    }
  });
});
