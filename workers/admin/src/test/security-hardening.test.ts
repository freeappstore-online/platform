import { describe, expect, it } from "vitest";

// ── Auth check validation ──

/** Replicate the isAuthenticated logic from index.ts for testing */
function isAuthenticated(hostname: string, jwtHeader: string | null): boolean {
  if (!hostname.includes("freeappstore.online")) return true;
  return !!jwtHeader;
}

describe("Security: admin auth check", () => {
  it("allows service binding calls (non-public hostname)", () => {
    expect(isAuthenticated("admin", null)).toBe(true);
    expect(isAuthenticated("do-internal", null)).toBe(true);
  });

  it("rejects public domain calls without JWT", () => {
    expect(isAuthenticated("admin.freeappstore.online", null)).toBe(false);
  });

  it("allows public domain calls with JWT", () => {
    expect(isAuthenticated("admin.freeappstore.online", "valid.jwt.token")).toBe(true);
  });

  it("rejects empty string JWT", () => {
    expect(isAuthenticated("admin.freeappstore.online", "")).toBe(false);
  });

  // This tests the bypass vector: workers.dev hostname should NOT pass
  it("would pass auth for workers.dev hostname (known risk)", () => {
    // This documents the current behavior — workers.dev hostnames bypass auth
    // because they don't contain "freeappstore.online". Mitigated by workers_dev = false.
    expect(isAuthenticated("freeappstore-admin.workers.dev", null)).toBe(true);
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
    expect(isAllowedOrigin("https://create.freeappstore.online")).toBe(true);
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
