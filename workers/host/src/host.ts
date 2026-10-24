export interface Env {
  DB: D1Database;
  APPS: R2Bucket;
  /** Service binding to the backend Worker (freeappstore-api), which serves
   *  api.freeappstore.online. The wildcard route preempts that Worker's
   *  custom_domain binding, so we dispatch reserved subdomains via this
   *  binding rather than letting the request fall through. */
  API?: Fetcher;
  /** Service binding to the KB host Worker (freeappstore-kb-host), which serves
   *  docs.freeappstore.online and kb.freeappstore.online. Same wildcard
   *  preemption issue as the API binding above. */
  KB?: Fetcher;
}

export interface Route {
  slug: string;
  zone: string;
  r2_prefix: string;
  store: string;
  /** 1 when the app opted into cross-origin isolation (#286). Default 0. */
  cross_origin_isolated?: number;
}

/**
 * Map a Host header like "kanban.freeappstore.online" to its R2 prefix.
 * Returns null if no row matches; caller serves 404.
 *
 * Lookup is keyed by (slug, zone) so the same slug can exist on multiple
 * store zones without collision. We trust the Host header only for lookup
 * — no privilege is attached to the resolved slug, so spoofing it just
 * picks which 404 you see.
 */
export async function resolveRoute(db: D1Database, host: string): Promise<Route | null> {
  const cleaned = host.toLowerCase().split(":")[0];
  const dot = cleaned.indexOf(".");
  if (dot < 1) return null;
  const slug = cleaned.slice(0, dot);
  const zone = cleaned.slice(dot + 1);
  if (!slug || !zone) return null;

  const row = await db
    .prepare("SELECT slug, zone, r2_prefix, store, cross_origin_isolated FROM routes WHERE slug = ?1 AND zone = ?2")
    .bind(slug, zone)
    .first<Route>();
  return row ?? null;
}

/** True when this route opted into COOP/COEP (#286). Missing/0 stays off. */
export function wantsCrossOriginIsolation(route: Pick<Route, "cross_origin_isolated">): boolean {
  return Number(route.cross_origin_isolated) === 1;
}

/**
 * Compute the R2 key for a given route + URL pathname. Directory paths and
 * `/` default to `index.html`; the leading slash is stripped because R2
 * keys are flat strings, not paths.
 */
export function r2KeyFor(route: Route, pathname: string): string {
  // Objects are uploaded under their literal filenames, but the URL pathname
  // is percent-encoded (`/my%20photo.png`). Malformed escapes stay as-is and
  // simply miss. R2 keys are flat, so a decoded `..` can't leave the prefix.
  let p = pathname;
  try {
    p = decodeURIComponent(pathname);
  } catch {}
  if (p === "" || p === "/" || p.endsWith("/")) p += "index.html";
  return `${route.r2_prefix}/${p.replace(/^\/+/, "")}`;
}

/**
 * Only Vite's content-hashed build output (`/assets/*`) may be cached as
 * immutable. Everything else in `public/` (manifest.json, icons, sw.js) keeps
 * its name across deploys, so a year-long immutable cache would pin the old
 * copy in returning browsers.
 */
export function isImmutablePath(pathname: string): boolean {
  return pathname.startsWith("/assets/");
}

/**
 * Compare a client's `If-None-Match` request header against an R2 object's
 * httpEtag. Returns true iff the browser already has a fresh copy and we
 * should respond 304 Not Modified.
 *
 * `If-None-Match: *` matches any existing resource. Otherwise the header
 * is a comma-separated list of etags (each quoted); we match by exact
 * string. R2 only emits strong etags, so we don't need W/ prefix handling.
 */
export function etagsMatch(headerValue: string | null, objectEtag: string): boolean {
  if (!headerValue) return false;
  const trimmed = headerValue.trim();
  if (trimmed === "*") return true;
  // If-None-Match on GET/HEAD uses weak comparison (RFC 9110).
  const weak = (value: string) => value.trim().replace(/^W\//, "");
  return trimmed.split(",").some((t) => weak(t) === weak(objectEtag));
}

export function robotsTxtFor(origin: string): string {
  return `User-agent: *
Allow: /

Sitemap: ${origin}/sitemap.xml
`;
}

export function sitemapXmlFor(origin: string): string {
  const loc = xmlEscape(`${origin}/`);
  return `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <url>
    <loc>${loc}</loc>
  </url>
</urlset>
`;
}

function xmlEscape(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&apos;");
}

/**
 * Browser features granted to every hosted app on its own origin (#284).
 *
 * Default-open: an app gets what a normal website on its own origin would.
 * The browser itself asks the user before granting camera, microphone,
 * location, sensors, USB/serial/HID/Bluetooth devices etc., so a
 * platform-level block only breaks apps (#267: `microphone=()` made a creator
 * delete a working feature) and protects nobody. `(self)` grants the app's own
 * origin but not cross-origin iframes it embeds.
 *
 * Only names Chromium recognises are listed: an unknown name logs a console
 * error on every page load of every app.
 *
 * The blocks, each with its reason:
 *   - browsing-topics: the Topics API hands the user's ad-interest topics to
 *     third-party scripts. The store requires apps not to track users.
 *   - payment: FreeAppStore apps take no payments (owner decision, #289).
 *     Monetization is a ProAppStore feature; `fas check` rejects payment code.
 */
export const PERMISSIONS_POLICY_SELF = [
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
] as const;

export const PERMISSIONS_POLICY_BLOCKED = ["browsing-topics", "payment"] as const;

function permissionsPolicy(crossOriginIsolated: boolean): string {
  const self = crossOriginIsolated ? [...PERMISSIONS_POLICY_SELF, "cross-origin-isolated"] : PERMISSIONS_POLICY_SELF;
  return [...self.map((f) => `${f}=(self)`), ...PERMISSIONS_POLICY_BLOCKED.map((f) => `${f}=()`)].join(", ");
}

const PERMISSIONS_POLICY = permissionsPolicy(false);

/**
 * Build the security headers we attach to every R2-served response. Split
 * out from the index.ts respond() helper so the policy is unit-testable
 * without spinning up the full Worker, and so the next person to tighten
 * CSP can edit one place. Pass-through args:
 *   - htmlCache:  true for HTML (short-lived caching), false otherwise.
 *
 * Analytics origins are listed explicitly in script-src + connect-src so
 * a future tightening (removing the broad `https:` and replacing with
 * an allowlist) doesn't silently break the platform analytics loader,
 * CF Web Analytics, or BYO GA4 / Plausible tags.
 */
export function securityHeaders(opts: { htmlCache: boolean; crossOriginIsolated?: boolean }): Headers {
  const headers = new Headers();
  if (opts.htmlCache) {
    headers.set("cache-control", "public, max-age=60, must-revalidate");
  } else {
    headers.set("cache-control", "public, max-age=31536000, immutable");
  }
  const csp = [
    "default-src 'self' https: data: blob:",
    "script-src 'self' 'unsafe-inline' 'unsafe-eval' 'wasm-unsafe-eval' blob: https: https://api.freeappstore.online https://static.cloudflareinsights.com https://www.googletagmanager.com https://plausible.io",
    "style-src 'self' 'unsafe-inline' https:",
    "img-src 'self' data: blob: https:",
    "font-src 'self' data: https:",
    "connect-src 'self' data: blob: https: wss: https://api.freeappstore.online https://cloudflareinsights.com https://www.google-analytics.com https://plausible.io",
    // Without worker-src, workers fall back to script-src; list blob: so
    // libraries that spawn Blob-URL workers (pdf.js, ffmpeg.wasm, Monaco,
    // emscripten pthreads) work (#284).
    "worker-src 'self' blob: https:",
    "frame-src 'self' https:",
    "frame-ancestors 'self' https://freeappstore.online https://*.freeappstore.online",
    "base-uri 'self'",
    "object-src 'none'",
    "upgrade-insecure-requests",
  ].join("; ");
  headers.set("content-security-policy", csp);
  headers.set("permissions-policy", opts.crossOriginIsolated ? permissionsPolicy(true) : PERMISSIONS_POLICY);
  headers.set("x-content-type-options", "nosniff");
  headers.set("referrer-policy", "strict-origin-when-cross-origin");
  headers.set("strict-transport-security", "max-age=31536000; includeSubDomains");
  // Opt-in only (#286). Default-off so existing apps keep third-party images,
  // embeds, and window.opener. credentialless lets no-cors subresources load
  // without cookies; Safari does not support it, so those browsers stay
  // non-isolated.
  if (opts.crossOriginIsolated) {
    headers.set("cross-origin-opener-policy", "same-origin");
    headers.set("cross-origin-embedder-policy", "credentialless");
  }
  return headers;
}

/**
 * Best-effort MIME guess from file extension. Defaults to octet-stream so
 * the browser doesn't sniff and execute something it shouldn't (combined
 * with X-Content-Type-Options: nosniff downstream).
 */
export function contentType(path: string): string {
  const ext = path.match(/\.([a-z0-9]+)$/i)?.[1]?.toLowerCase();
  switch (ext) {
    case "html":
      return "text/html; charset=utf-8";
    case "js":
    case "mjs":
      return "application/javascript; charset=utf-8";
    case "css":
      return "text/css; charset=utf-8";
    case "json":
      return "application/json; charset=utf-8";
    case "svg":
      return "image/svg+xml";
    case "png":
      return "image/png";
    case "jpg":
    case "jpeg":
      return "image/jpeg";
    case "webp":
      return "image/webp";
    case "gif":
      return "image/gif";
    case "ico":
      return "image/x-icon";
    case "woff":
      return "font/woff";
    case "woff2":
      return "font/woff2";
    case "wasm":
      return "application/wasm";
    case "txt":
      return "text/plain; charset=utf-8";
    case "xml":
      return "application/xml; charset=utf-8";
    case "webmanifest":
      return "application/manifest+json";
    case "map":
      return "application/json; charset=utf-8";
    default:
      return "application/octet-stream";
  }
}

/** Authored crawl files are mutable public assets, with normal conditional/HEAD semantics. */
export function crawlAssetResponse(
  obj: R2ObjectBody,
  pathname: string,
  method: string,
  ifNoneMatch: string | null,
  opts: { crossOriginIsolated?: boolean } = {},
): Response {
  const headers = securityHeaders({ htmlCache: true, crossOriginIsolated: opts.crossOriginIsolated });
  headers.set("content-type", contentType(pathname));
  headers.set("etag", obj.httpEtag);
  const unchanged = etagsMatch(ifNoneMatch, obj.httpEtag);
  return new Response(unchanged || method === "HEAD" ? null : obj.body, {
    status: unchanged ? 304 : 200,
    headers,
  });
}
