import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const web = resolve(__dirname, "../..");
const root = resolve(web, "..");

function read(relativeTo: string, filePath: string): string {
  return readFileSync(resolve(relativeTo, filePath), "utf-8");
}

describe("CSS compliance", () => {
  const css = read(web, "src/index.css");

  it("contains standard design-system surface + text tokens", () => {
    expect(css).toContain("--paper");
    expect(css).toContain("--panel");
    expect(css).toContain("--panel-alt");
    expect(css).toContain("--ink");
    expect(css).toContain("--ink-strong");
    expect(css).toContain("--accent");
    expect(css).toContain("--line");
  });

  it("contains shape + font tokens", () => {
    expect(css).toContain("--radius");
    expect(css).toContain("--shadow");
    expect(css).toContain("--font-body");
    expect(css).toContain("--font-display");
  });

  it("does NOT use banned aliases", () => {
    expect(css).not.toMatch(/--surface\b/);
    expect(css).not.toMatch(/--glass\b/);
    expect(css).not.toMatch(/--dock\b/);
  });

  it("has dark mode via [data-theme] (not prefers-color-scheme apply)", () => {
    expect(css).toContain('[data-theme="dark"]');
  });

  it("references Manrope + Fraunces fonts", () => {
    expect(css).toContain("Manrope");
    expect(css).toContain("Fraunces");
  });

  it("prevents horizontal overflow", () => {
    expect(css).toContain("overflow-x: hidden");
  });

  it("has box-sizing border-box", () => {
    expect(css).toContain("box-sizing: border-box");
  });

  it("sets input font-size 16px (prevents iOS zoom)", () => {
    expect(css).toContain("font-size: 16px");
  });
});

describe("HTML compliance", () => {
  const html = read(web, "index.html");

  it("contains VibeCode in title", () => {
    expect(html).toMatch(/<title>[^<]*VibeCode[^<]*<\/title>/);
  });

  it("has accessible viewport meta tag (zoom allowed)", () => {
    expect(html).toContain("width=device-width");
    // Pinch-zoom must NOT be blocked (a11y). 16px inputs prevent iOS focus-zoom instead.
    expect(html).not.toContain("user-scalable=no");
    expect(html).not.toContain("maximum-scale=1");
  });

  it("has no-flash theme boot script using the shared key", () => {
    expect(html).toContain("stores-theme");
    expect(html).toContain("dataset.theme");
  });

  it("has manifest link", () => {
    expect(html).toMatch(/<link\s[^>]*rel="manifest"/);
  });

  it("has PWA meta tags", () => {
    expect(html).toContain("apple-mobile-web-app-capable");
    expect(html).toContain("mobile-web-app-capable");
  });

  it("loads brand fonts", () => {
    expect(html).toContain("Manrope");
    expect(html).toContain("Fraunces");
  });
});

describe("PWA manifest", () => {
  it("exists with required fields", () => {
    const path = resolve(web, "public/manifest.json");
    expect(existsSync(path)).toBe(true);
    const manifest = JSON.parse(readFileSync(path, "utf-8"));
    expect(manifest).toHaveProperty("name");
    expect(manifest).toHaveProperty("display");
    expect(manifest).toHaveProperty("start_url");
  });
});

describe("SPA routing", () => {
  it("has _redirects for CF Pages SPA", () => {
    const path = resolve(web, "public/_redirects");
    expect(existsSync(path)).toBe(true);
    const content = readFileSync(path, "utf-8");
    expect(content).toContain("/*");
    expect(content).toContain("/index.html");
  });
});

describe("No tracking", () => {
  it("no tracking SDKs in package.json", () => {
    const pkg = read(web, "package.json");
    const forbidden = ["google-analytics", "gtag", "amplitude", "mixpanel", "segment", "hotjar", "plausible", "posthog"];
    for (const f of forbidden) {
      expect(pkg).not.toContain(f);
    }
  });
});

describe("License", () => {
  it("MIT LICENSE exists", () => {
    expect(existsSync(resolve(root, "LICENSE"))).toBe(true);
    const license = readFileSync(resolve(root, "LICENSE"), "utf-8");
    expect(license.toLowerCase()).toContain("mit");
  });
});

describe("Nav component", () => {
  const nav = read(web, "src/components/Nav.tsx");

  it("has freeappstore.online link", () => {
    expect(nav).toContain("freeappstore.online");
  });

  it("has mobile hamburger menu", () => {
    expect(nav).toContain("sm:hidden");
    expect(nav).toContain("Menu");
  });
});
