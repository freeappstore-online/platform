import { describe, expect, it } from "vitest";

// ── Auth check validation ──

/**
 * Replicate the isAuthenticated decision from index.ts for testing. The real
 * impl cryptographically verifies the JWT; here JWT acceptance is a boolean.
 * The Host-based bypass was removed (commit 1a9e102) and replaced with a
 * shared-secret (INTERNAL_TOKEN) bypass for service-to-service calls that
 * carry no CF Access JWT (e.g. backend → /api/provision via service binding).
 */
function isAuthenticated(opts: {
  accessConfigured: boolean;
  jwtValid: boolean;
  internalToken?: string;
  sentToken?: string | null;
}): boolean {
  if (!opts.accessConfigured) return true; // local dev / test
  if (opts.internalToken && opts.sentToken && opts.sentToken === opts.internalToken) return true;
  return opts.jwtValid;
}

describe("Security: admin auth check", () => {
  const cfg = { accessConfigured: true, internalToken: "secret-123" };

  it("allows local dev / test when CF Access is unconfigured", () => {
    expect(isAuthenticated({ accessConfigured: false, jwtValid: false })).toBe(true);
  });

  it("rejects public calls without a valid JWT", () => {
    expect(isAuthenticated({ ...cfg, jwtValid: false })).toBe(false);
  });

  it("allows public calls with a valid JWT", () => {
    expect(isAuthenticated({ ...cfg, jwtValid: true })).toBe(true);
  });

  it("allows service-to-service calls with the shared internal token", () => {
    // backend → /api/provision via service binding (no CF Access JWT)
    expect(isAuthenticated({ ...cfg, jwtValid: false, sentToken: "secret-123" })).toBe(true);
  });

  it("rejects a wrong or missing internal token (no JWT)", () => {
    expect(isAuthenticated({ ...cfg, jwtValid: false, sentToken: "wrong" })).toBe(false);
    expect(isAuthenticated({ ...cfg, jwtValid: false, sentToken: null })).toBe(false);
  });

  it("does not bypass when INTERNAL_TOKEN is unset on the worker", () => {
    expect(isAuthenticated({ accessConfigured: true, jwtValid: false, sentToken: "anything" })).toBe(false);
  });
});

// ── Rate limit JWT parsing ──

describe("Security: rate limit JWT handling", () => {
  function extractUserFromJwt(jwt: string): string | null {
    try {
      const payload = JSON.parse(atob(jwt.split(".")[1]!));
      const email = payload.email || payload.sub || "";
      return email.includes("@") ? email.split("@")[0]! : email;
    } catch {
      return null;
    }
  }

  it("extracts user from valid JWT", () => {
    const payload = btoa(JSON.stringify({ email: "testuser@github.com" }));
    const jwt = `header.${payload}.signature`;
    expect(extractUserFromJwt(jwt)).toBe("testuser");
  });

  it("returns null for malformed JWT (no dots)", () => {
    expect(extractUserFromJwt("nodots")).toBe(null);
  });

  it("returns null for invalid base64 payload", () => {
    expect(extractUserFromJwt("a.!!!invalid!!!.c")).toBe(null);
  });

  it("returns null for non-JSON payload", () => {
    const payload = btoa("not json");
    expect(extractUserFromJwt(`a.${payload}.c`)).toBe(null);
  });

  it("handles empty email gracefully", () => {
    const payload = btoa(JSON.stringify({ email: "" }));
    expect(extractUserFromJwt(`a.${payload}.c`)).toBe("");
  });

  it("falls back to sub claim when no email", () => {
    const payload = btoa(JSON.stringify({ sub: "user123" }));
    expect(extractUserFromJwt(`a.${payload}.c`)).toBe("user123");
  });
});

// ── Provision form XSS prevention ──

describe("Security: HTML escaping in provision form", () => {
  function esc(s: string): string {
    return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  }

  const xssPayloads = [
    "<script>alert(1)</script>",
    "<img onerror=alert(1) src=x>",
    '"><svg onload=alert(1)>',
    "' onmouseover='alert(1)",
    '<iframe src="javascript:alert(1)">',
    '{{constructor.constructor("return this")()}}',
    "${alert(1)}",
    '<a href="javascript:alert(1)">click</a>',
  ];

  for (const payload of xssPayloads) {
    it(`escapes: ${payload.slice(0, 40)}...`, () => {
      const escaped = esc(payload);
      expect(escaped).not.toContain("<script");
      expect(escaped).not.toContain("<img");
      expect(escaped).not.toContain("<svg");
      expect(escaped).not.toContain("<iframe");
      expect(escaped).not.toContain("<a ");
      // The escaped version should not contain raw < or >
      expect(escaped).not.toMatch(/<[a-z]/i);
    });
  }

  it("preserves safe text", () => {
    expect(esc("GitHub repo")).toBe("GitHub repo");
    expect(esc("Created freeappstore-online/my-app")).toBe("Created freeappstore-online/my-app");
  });
});

// ── Input validation ──

describe("Security: validateId", () => {
  function validateId(id: string): string | null {
    if (!id) return "ID is required";
    if (id.length > 58) return "ID must be 58 characters or less";
    if (!/^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/.test(id)) return "ID must be lowercase letters, numbers, and dashes only.";
    if (id.startsWith("free") || id.startsWith("pro")) return "ID must not start with 'free' or 'pro'";
    return null;
  }

  it("rejects empty ID", () => {
    expect(validateId("")).not.toBeNull();
  });

  it("rejects uppercase", () => {
    expect(validateId("MyApp")).not.toBeNull();
  });

  it("rejects path traversal attempt", () => {
    expect(validateId("../admin")).not.toBeNull();
  });

  it("rejects URL-like ID", () => {
    expect(validateId("app?foo=bar")).not.toBeNull();
  });

  it("rejects ID with slashes", () => {
    expect(validateId("app/evil")).not.toBeNull();
  });

  it("rejects 'free' prefix", () => {
    expect(validateId("freeapp")).not.toBeNull();
  });

  it("rejects 'pro' prefix", () => {
    expect(validateId("proapp")).not.toBeNull();
  });

  it("rejects overly long ID", () => {
    expect(validateId("a".repeat(59))).not.toBeNull();
  });

  it("accepts valid ID", () => {
    expect(validateId("my-cool-app")).toBeNull();
  });

  it("accepts single char", () => {
    expect(validateId("a")).toBeNull();
  });
});

// ── CORS validation ──

describe("Security: CORS origin validation", () => {
  function isAllowedOrigin(origin: string): boolean {
    return !!(
      origin.endsWith(".freeappstore.online") ||
      origin.endsWith(".freegamestore.online") ||
      origin === "https://freeappstore.online" ||
      origin === "https://freegamestore.online" ||
      origin.startsWith("http://localhost")
    );
  }

  it("allows freeappstore.online", () => {
    expect(isAllowedOrigin("https://freeappstore.online")).toBe(true);
  });

  it("allows subdomains", () => {
    expect(isAllowedOrigin("https://admin.freeappstore.online")).toBe(true);
    expect(isAllowedOrigin("https://console.freeappstore.online")).toBe(true);
  });

  it("rejects random domains", () => {
    expect(isAllowedOrigin("https://evil.com")).toBe(false);
    expect(isAllowedOrigin("https://notfreeappstore.online")).toBe(false);
  });

  it("rejects subdomain of attacker domain", () => {
    // evil.freeappstore.online.evil.com should NOT match
    expect(isAllowedOrigin("https://evil.freeappstore.online.evil.com")).toBe(false);
  });

  it("rejects pages.dev origins (no longer used)", () => {
    expect(isAllowedOrigin("https://free-evil.pages.dev")).toBe(false);
    expect(isAllowedOrigin("https://freeappstore-timer.pages.dev")).toBe(false);
    expect(isAllowedOrigin("https://evil-app.pages.dev")).toBe(false);
  });
});
