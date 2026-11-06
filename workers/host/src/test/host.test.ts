import { describe, expect, it } from "vitest";
import {
  CONSOLE_INLINE_SCRIPT_HASHES,
  contentType,
  crawlAssetResponse,
  etagsMatch,
  isFirstPartyRoute,
  isImmutablePath,
  PERMISSIONS_POLICY_BLOCKED,
  PERMISSIONS_POLICY_EMBED,
  PERMISSIONS_POLICY_SELF,
  policyFor,
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

  it("frame-ancestors allows storefront and console preview iframes only, not sibling apps (#499)", () => {
    const csp = html.get("content-security-policy") ?? "";
    const directive = csp.split("; ").find((d) => d.startsWith("frame-ancestors "));
    expect(directive).toBe("frame-ancestors 'self' https://freeappstore.online https://console.freeappstore.online");
    expect(csp).not.toContain("pages.dev");
    expect(csp).not.toContain("https://*.freeappstore.online");
  });

  it("upgrades insecure requests + sets HSTS", () => {
    expect(html.get("content-security-policy")).toContain("upgrade-insecure-requests");
    expect(html.get("strict-transport-security")).toMatch(/max-age=\d+/);
    expect(html.get("strict-transport-security")).toContain("includeSubDomains");
  });

  // #284 default-open: every feature on the app's own origin, one written block.
  // #288: low-risk media features are `=*` so YouTube/Vimeo/Spotify/CodePen
  // iframes the app embeds can fullscreen, autoplay, and play DRM.
  const embed = new Set<string>(PERMISSIONS_POLICY_EMBED);
  it.each(PERMISSIONS_POLICY_SELF.filter((feature) => !embed.has(feature)))(
    "Permissions-Policy grants %s to the app's own origin",
    (feature) => {
      const entries = (html.get("permissions-policy") ?? "").split(", ");
      expect(entries).toContain(`${feature}=(self)`);
    },
  );

  it.each([...PERMISSIONS_POLICY_EMBED])("Permissions-Policy grants %s to the app and to embedded media origins (#288)", (feature) => {
    const entries = (html.get("permissions-policy") ?? "").split(", ");
    expect(entries).toContain(`${feature}=*`);
    expect(entries).not.toContain(`${feature}=(self)`);
  });

  it("embed features are a subset of the default-open list (#288)", () => {
    const self = new Set<string>(PERMISSIONS_POLICY_SELF);
    for (const feature of PERMISSIONS_POLICY_EMBED) {
      expect(self.has(feature)).toBe(true);
    }
  });

  it("does not wildcard camera, microphone, location, or device features (#288)", () => {
    const entries = (html.get("permissions-policy") ?? "").split(", ");
    for (const feature of ["camera", "microphone", "geolocation", "usb", "serial", "hid", "bluetooth", "display-capture"]) {
      expect(entries).toContain(`${feature}=(self)`);
    }
  });

  it("Permissions-Policy blocks only the Topics API (no tracking) and payments (#289)", () => {
    const entries = (html.get("permissions-policy") ?? "").split(", ");
    expect(entries.filter((e) => e.endsWith("=()"))).toEqual(PERMISSIONS_POLICY_BLOCKED.map((f) => `${f}=()`));
    expect(entries).not.toContain("payment=(self)");
    expect(entries).not.toContain("payment=*");
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
    expect(entries).toContain("fullscreen=*");
  });
});

// The creator console is a first-party SPA holding the creator's session: it
// gets an allowlist CSP + X-Frame-Options, not the default-open app policy (#497).
describe("first-party console policy", () => {
  const console_: Route = { slug: "console", zone: "freeappstore.online", r2_prefix: "apps/console", store: "apps" };
  const html = securityHeaders({ htmlCache: true, firstParty: true });
  const csp = html.get("content-security-policy") ?? "";
  const directive = (name: string) => csp.split("; ").find((d) => d === name || d.startsWith(`${name} `)) ?? "";

  it("recognises only the console routes row", () => {
    expect(isFirstPartyRoute(console_)).toBe(true);
    expect(isFirstPartyRoute(kanban)).toBe(false);
    expect(isFirstPartyRoute({ zone: "space", r2_prefix: "apps/console" })).toBe(false);
    expect(policyFor(console_)).toEqual({ crossOriginIsolated: false, firstParty: true });
    expect(policyFor(kanban)).toEqual({ crossOriginIsolated: false, firstParty: false });
  });

  it("allows no inline, eval, or third-party script beyond the hashed boot scripts", () => {
    expect(directive("script-src")).toBe(`script-src 'self' ${CONSOLE_INLINE_SCRIPT_HASHES.map((h) => `'${h}'`).join(" ")}`);
    expect(directive("script-src")).not.toContain("'unsafe-inline'");
    expect(csp).not.toContain("'unsafe-eval'");
    for (const name of ["script-src", "connect-src", "frame-src", "style-src", "font-src"]) {
      expect(directive(name).split(" "), name).not.toContain("https:");
    }
    expect(directive("default-src")).toBe("default-src 'self'");
    expect(directive("worker-src")).toBe("worker-src 'self'");
  });

  it("script hashes match the inline boot scripts in sites/console/web/index.html", async () => {
    // workers-types is the only tsconfig `types` entry, so node builtins come in
    // through a typed dynamic import (same as migration-0002.test.ts).
    const nodeModule = <T>(name: string) => import(/* @vite-ignore */ name) as Promise<T>;
    const fs = await nodeModule<{ readFileSync(file: URL, encoding: "utf8"): string }>("node:fs");
    const crypto = await nodeModule<{ createHash(alg: "sha256"): { update(data: string): { digest(enc: "base64"): string } } }>(
      "node:crypto",
    );
    const indexHtml = fs.readFileSync(
      new URL("../../../../sites/console/web/index.html", (import.meta as unknown as { url: string }).url),
      "utf8",
    );
    const inline = [...indexHtml.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g)].map(
      (m) => `sha256-${crypto.createHash("sha256").update(m[1]).digest("base64")}`,
    );
    expect(inline).toEqual([...CONSOLE_INLINE_SCRIPT_HASHES]);
  });

  it("lets the console reach only the platform services and GitHub it calls", () => {
    expect(directive("connect-src")).toBe(
      "connect-src 'self' https://api.freeappstore.online wss://api.freeappstore.online https://agent.freeappstore.online https://admin.freeappstore.online https://api.github.com https://raw.githubusercontent.com https://fonts.googleapis.com https://fonts.gstatic.com",
    );
    // 'unsafe-inline' for styles only: the SDK UI kit injects a keyframes <style>.
    expect(directive("style-src")).toBe("style-src 'self' 'unsafe-inline' https://fonts.googleapis.com");
    expect(directive("font-src")).toBe("font-src 'self' https://fonts.gstatic.com");
    expect(directive("frame-src")).toBe("frame-src https://*.freeappstore.online");
  });

  it("cannot be framed, posts forms only to itself, and keeps the defence-in-depth locks", () => {
    expect(directive("frame-ancestors")).toBe("frame-ancestors 'none'");
    expect(html.get("x-frame-options")).toBe("DENY");
    expect(directive("form-action")).toBe("form-action 'self'");
    expect(directive("base-uri")).toBe("base-uri 'self'");
    expect(directive("object-src")).toBe("object-src 'none'");
    expect(csp).toContain("upgrade-insecure-requests");
    expect(html.get("x-content-type-options")).toBe("nosniff");
    expect(html.get("strict-transport-security")).toContain("includeSubDomains");
  });

  it("hosted apps keep the default-open policy and no X-Frame-Options; crawl files follow the route's policy", () => {
    const app = securityHeaders({ htmlCache: true });
    expect(app.get("x-frame-options")).toBeNull();
    expect(app.get("content-security-policy")).toContain("'unsafe-inline'");
    const crawl = crawlAssetResponse({ body: null, httpEtag: '"x"' } as unknown as R2ObjectBody, "/robots.txt", "HEAD", null, {
      firstParty: true,
    });
    expect(crawl.headers.get("x-frame-options")).toBe("DENY");
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
