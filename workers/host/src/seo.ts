import type { Route } from "./host";

export interface PublicApp {
  id: string;
  name: string;
  description: string;
  appUrl: string;
  status?: string;
}

let cached: { apps: PublicApp[]; expires: number } | undefined;
let loading: Promise<PublicApp[]> | undefined;

/** Only approved public storefront entries qualify, never a provisioning route alone. */
export async function publicApp(route: Route): Promise<PublicApp | undefined> {
  if (!cached || cached.expires <= Date.now()) {
    loading ??= (async () => {
      try {
        const response = await fetch("https://freeappstore.online/registry.json", { signal: AbortSignal.timeout(2000) });
        if (!response.ok) return [];
        const data = (await response.json()) as { apps?: PublicApp[] };
        if (!Array.isArray(data.apps)) return [];
        cached = { apps: data.apps, expires: Date.now() + 60_000 };
        return data.apps;
      } catch {
        return [];
      } finally {
        loading = undefined;
      }
    })();
    const apps = await loading;
    return eligible(apps, route);
  }
  return eligible(cached.apps, route);
}

function eligible(apps: PublicApp[], route: Route): PublicApp | undefined {
  return apps.find((app) => {
    if (
      !app ||
      app.id !== route.slug ||
      typeof app.name !== "string" ||
      !app.name.trim() ||
      typeof app.description !== "string" ||
      !app.description.trim()
    )
      return false;
    if (app.status !== undefined && !["live", "published", "approved"].includes(app.status)) return false;
    try {
      return new URL(app.appUrl).href === `https://${route.slug}.freeappstore.online/`;
    } catch {
      return false;
    }
  });
}

function escapeMetadata(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

/** Fill missing tags while preserving app-owned metadata, canonical and noindex intent. */
export function injectMetadata(response: Response, app: PublicApp): Response {
  const canonical = new URL(app.appUrl).href;
  const title = `${app.name} — FreeAppStore`;
  const tags: Record<string, string> = {
    description: app.description,
    "og:title": title,
    "og:description": app.description,
    "og:url": canonical,
    "og:type": "website",
    "og:site_name": "FreeAppStore",
    "twitter:card": "summary",
    "twitter:title": title,
    "twitter:description": app.description,
  };
  const found = new Set<string>();
  let rewriter = new HTMLRewriter()
    .on("head title", {
      element() {
        found.add("title");
      },
    })
    .on('head link[rel="canonical"]', {
      element(el: Element) {
        if (el.getAttribute("href")?.trim()) found.add("canonical");
        else el.remove();
      },
    });
  for (const [key, value] of Object.entries(tags)) {
    const attribute = key.startsWith("og:") ? "property" : "name";
    rewriter = rewriter.on(`head meta[${attribute}="${key}"]`, {
      element(el: Element) {
        if (!el.getAttribute("content")?.trim()) el.setAttribute("content", value);
        found.add(key);
      },
    });
  }
  rewriter = rewriter.on("head", {
    element(el: Element) {
      el.onEndTag((end) => {
        const missing = [];
        if (!found.has("title")) missing.push(`<title>${escapeMetadata(title)}</title>`);
        if (!found.has("canonical")) missing.push(`<link rel="canonical" href="${escapeMetadata(canonical)}">`);
        for (const [key, value] of Object.entries(tags)) {
          if (!found.has(key))
            missing.push(`<meta ${key.startsWith("og:") ? "property" : "name"}="${key}" content="${escapeMetadata(value)}">`);
        }
        end.before(missing.join("\n"), { html: true });
      });
    },
  });
  const headers = new Headers(response.headers);
  // Registry metadata can change independently of R2 bytes.
  headers.delete("etag");
  headers.delete("content-length");
  headers.set("cache-control", "no-store");
  return rewriter.transform(new Response(response.body, { status: response.status, headers }));
}
