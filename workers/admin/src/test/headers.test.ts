// The admin UI's static-asset headers (#516) live in web/public/_headers. The
// CSP pins the inline theme script in web/index.html by hash, so an edit to
// that script must fail here instead of blanking the admin UI.

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const read = (rel: string) => readFileSync(new URL(rel, import.meta.url), "utf8");

const headers = Object.fromEntries(
  read("../../web/public/_headers")
    .split("\n")
    .filter((line) => /^\s+\S/.test(line))
    .map((line) => {
      const i = line.indexOf(":");
      return [line.slice(0, i).trim().toLowerCase(), line.slice(i + 1).trim()];
    }),
);
const csp: string = headers["content-security-policy"];
const directive = (name: string) => csp.split("; ").find((d) => d.startsWith(`${name} `));

describe("admin UI security headers (#516)", () => {
  it("cannot be framed and sends the transport and sniffing locks", () => {
    expect(directive("frame-ancestors")).toBe("frame-ancestors 'none'");
    expect(headers["x-frame-options"]).toBe("DENY");
    expect(headers["strict-transport-security"]).toBe("max-age=31536000; includeSubDomains");
    expect(headers["x-content-type-options"]).toBe("nosniff");
    expect(headers["referrer-policy"]).toBe("strict-origin-when-cross-origin");
  });

  it("reaches only the platform API and the analytics beacon", () => {
    expect(directive("connect-src")).toBe("connect-src 'self' https://api.freeappstore.online https://cloudflareinsights.com");
  });

  it("allows no inline or eval script beyond the hashed theme script", () => {
    expect(csp).not.toContain("'unsafe-inline'");
    expect(csp).not.toContain("'unsafe-eval'");
    expect(directive("default-src")).toBe("default-src 'self'");
    expect(directive("object-src")).toBe("object-src 'none'");
    for (const name of ["script-src", "style-src", "connect-src", "font-src"]) {
      expect(directive(name)?.split(" "), name).not.toContain("https:");
    }
  });

  it("script hashes match the inline scripts in web/index.html", () => {
    const inline = [...read("../../web/index.html").matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g)].map(
      (m) => `'sha256-${createHash("sha256").update(m[1]).digest("base64")}'`,
    );
    // static.cloudflareinsights.com: the edge injects the Web Analytics beacon.
    expect(directive("script-src")).toBe(`script-src 'self' ${inline.join(" ")} https://static.cloudflareinsights.com`);
  });
});
