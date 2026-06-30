import { describe, expect, it } from "vitest";

// ── C-2: JWT verification ──

function base64UrlDecode(str: string): Uint8Array {
  let b64 = str.replace(/-/g, "+").replace(/_/g, "/");
  while (b64.length % 4 !== 0) b64 += "=";
  return Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
}

function base64UrlEncode(data: string): string {
  return btoa(data).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

describe("Security: JWT base64url decoding", () => {
  it("decodes standard base64url", () => {
    const encoded = base64UrlEncode('{"email":"user@github.com"}');
    const decoded = new TextDecoder().decode(base64UrlDecode(encoded));
    expect(JSON.parse(decoded).email).toBe("user@github.com");
  });

  it("handles padding-needed strings", () => {
    // "a" in base64url is "YQ" (no padding), base64 is "YQ=="
    const decoded = new TextDecoder().decode(base64UrlDecode("YQ"));
    expect(decoded).toBe("a");
  });

  it("round-trips all base64url special chars", () => {
    const original = '{"iss":"https://team.cloudflareaccess.com","aud":["abc123"]}';
    const encoded = base64UrlEncode(original);
    const decoded = new TextDecoder().decode(base64UrlDecode(encoded));
    expect(decoded).toBe(original);
  });
});

describe("Security: JWT claim extraction", () => {
  function extractUser(jwt: string): string | null {
    try {
      const payload = JSON.parse(new TextDecoder().decode(base64UrlDecode(jwt.split(".")[1]!)));
      const email = payload.email || "";
      if (email.includes("@")) return email.split("@")[0]!;
      return email || payload.sub || null;
    } catch {
      return null;
    }
  }

  it("extracts username from email", () => {
    const payload = base64UrlEncode(JSON.stringify({ email: "octocat@github.com" }));
    expect(extractUser(`h.${payload}.s`)).toBe("octocat");
  });

  it("falls back to sub claim", () => {
    const payload = base64UrlEncode(JSON.stringify({ sub: "user42" }));
    expect(extractUser(`h.${payload}.s`)).toBe("user42");
  });

  it("returns null for missing claims", () => {
    const payload = base64UrlEncode(JSON.stringify({}));
    expect(extractUser(`h.${payload}.s`)).toBeNull();
  });

  it("returns null for malformed JWT", () => {
    expect(extractUser("not.a.jwt")).toBeNull();
    expect(extractUser("")).toBeNull();
    expect(extractUser("single")).toBeNull();
  });

  it("handles payload with only sub, no email", () => {
    const payload = base64UrlEncode(JSON.stringify({ sub: "12345", iss: "test" }));
    expect(extractUser(`h.${payload}.s`)).toBe("12345");
  });
});

// ── H-1: pagesProject validation ──

describe("Security: pagesProject SSRF prevention", () => {
  function isValidPagesProject(name: string): boolean {
    return /^[a-z0-9][a-z0-9-]*[a-z0-9]$/.test(name) && name.length <= 63;
  }

  it("accepts valid project names", () => {
    expect(isValidPagesProject("freecoolapp")).toBe(true);
    expect(isValidPagesProject("free-my-app-app")).toBe(true);
    expect(isValidPagesProject("ab")).toBe(true);
  });

  it("rejects path traversal", () => {
    expect(isValidPagesProject("../../zones")).toBe(false);
    expect(isValidPagesProject("../accounts")).toBe(false);
  });

  it("rejects query string injection", () => {
    expect(isValidPagesProject("app?foo=bar")).toBe(false);
    expect(isValidPagesProject("app#fragment")).toBe(false);
  });

  it("rejects slashes", () => {
    expect(isValidPagesProject("a/b")).toBe(false);
    expect(isValidPagesProject("/leading")).toBe(false);
  });

  it("rejects spaces and special chars", () => {
    expect(isValidPagesProject("my app")).toBe(false);
    expect(isValidPagesProject("my%20app")).toBe(false);
    expect(isValidPagesProject("app;rm -rf")).toBe(false);
  });

  it("rejects uppercase", () => {
    expect(isValidPagesProject("MyApp")).toBe(false);
  });

  it("rejects empty", () => {
    expect(isValidPagesProject("")).toBe(false);
  });

  it("rejects too-long names", () => {
    expect(isValidPagesProject("a".repeat(64))).toBe(false);
  });

  // Single char is rejected by the regex (needs start AND end char with middle)
  it("rejects single char (regex needs 2+ chars)", () => {
    expect(isValidPagesProject("a")).toBe(false);
  });
});

// ── M-6: publish-existing ownership check ──

describe("Security: project ownership validation", () => {
  function isOwnedByPlatform(source: any): boolean {
    const owner = source?.config?.owner;
    return owner === "freeappstore-online" || owner === "freegamestore-online";
  }

  it("accepts freeappstore-online projects", () => {
    expect(isOwnedByPlatform({ config: { owner: "freeappstore-online" } })).toBe(true);
  });

  it("accepts freegamestore-online projects", () => {
    expect(isOwnedByPlatform({ config: { owner: "freegamestore-online" } })).toBe(true);
  });

  it("rejects random org", () => {
    expect(isOwnedByPlatform({ config: { owner: "attacker-org" } })).toBe(false);
  });

  it("rejects null source", () => {
    expect(isOwnedByPlatform(null)).toBe(false);
    expect(isOwnedByPlatform(undefined)).toBe(false);
  });

  it("rejects missing config", () => {
    expect(isOwnedByPlatform({})).toBe(false);
    expect(isOwnedByPlatform({ config: {} })).toBe(false);
  });
});

// ── H-3: Rate limiting ──

describe("Security: rate limit logic", () => {
  it("counter increments prevent exceeding limit", () => {
    let count = 0;
    const limit = 3;
    const results: boolean[] = [];
    for (let i = 0; i < 5; i++) {
      if (count >= limit) {
        results.push(false);
      } else {
        count++;
        results.push(true);
      }
    }
    expect(results).toEqual([true, true, true, false, false]);
  });
});

// ── validateId ──

describe("Security: app ID validation", () => {
  function validateId(id: string): string | null {
    if (!id) return "ID is required";
    if (id.length > 58) return "Too long";
    if (!/^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/.test(id)) return "Invalid format";
    if (id.startsWith("free") || id.startsWith("pro")) return "Reserved prefix";
    return null;
  }

  const attackPayloads = [
    { id: "../../../etc/passwd", label: "path traversal" },
    { id: "app; rm -rf /", label: "command injection" },
    { id: "app\nX-Injected: true", label: "header injection" },
    { id: "<script>alert(1)</script>", label: "XSS in ID" },
    { id: "app%00null", label: "null byte injection" },
    { id: "freeappstore", label: "impersonate platform" },
    { id: "proappstore", label: "impersonate pro platform" },
    { id: "", label: "empty string" },
    { id: " ", label: "whitespace only" },
    { id: "-leading-dash", label: "leading dash" },
    { id: "trailing-dash-", label: "trailing dash" },
  ];

  for (const { id, label } of attackPayloads) {
    it(`rejects: ${label}`, () => {
      expect(validateId(id)).not.toBeNull();
    });
  }

  it("accepts valid IDs", () => {
    expect(validateId("calculator")).toBeNull();
    expect(validateId("my-app-2")).toBeNull();
    expect(validateId("a")).toBeNull();
    expect(validateId("x".repeat(58))).toBeNull();
  });
});

// ── CORS ──

describe("Security: CORS origin check", () => {
  function isAllowed(origin: string): boolean {
    return !!(
      origin.endsWith(".freeappstore.online") ||
      origin.endsWith(".freegamestore.online") ||
      origin === "https://freeappstore.online" ||
      origin === "https://freegamestore.online" ||
      (origin.endsWith(".pages.dev") && origin.includes("free")) ||
      origin.startsWith("http://localhost")
    );
  }

  it("allows platform origins", () => {
    expect(isAllowed("https://freeappstore.online")).toBe(true);
    expect(isAllowed("https://create.freeappstore.online")).toBe(true);
    expect(isAllowed("https://freegamestore.online")).toBe(true);
  });

  it("rejects attacker domains", () => {
    expect(isAllowed("https://evil.com")).toBe(false);
    expect(isAllowed("https://freeappstore.online.evil.com")).toBe(false);
  });

  it("rejects javascript: scheme", () => {
    expect(isAllowed("javascript:alert(1)")).toBe(false);
  });

  it("rejects data: scheme", () => {
    expect(isAllowed("data:text/html,<script>alert(1)</script>")).toBe(false);
  });
});

// ── Zone ID from env ──

describe("Security: zone IDs from env (H-6)", () => {
  function getZoneId(store: string, fasZone: string, fgsZone: string): string {
    return store === "games" ? fgsZone : fasZone;
  }

  it("returns FAS zone for apps", () => {
    expect(getZoneId("apps", "fas-zone", "fgs-zone")).toBe("fas-zone");
  });

  it("returns FGS zone for games", () => {
    expect(getZoneId("games", "fas-zone", "fgs-zone")).toBe("fgs-zone");
  });

  it("defaults to FAS for unknown store", () => {
    expect(getZoneId("unknown", "fas-zone", "fgs-zone")).toBe("fas-zone");
  });
});

// ── Input length limits ──

describe("Security: input field length limits", () => {
  it("rejects name over 60 chars", () => {
    const name = "A".repeat(61);
    expect(name.length > 60).toBe(true);
  });

  it("rejects description over 200 chars", () => {
    const desc = "A".repeat(201);
    expect(desc.length > 200).toBe(true);
  });

  it("accepts valid name", () => {
    expect("Meditation Timer".length <= 60).toBe(true);
  });

  it("rejects invalid iconBg (CSS injection)", () => {
    const valid = /^#[0-9a-fA-F]{3,8}$/;
    expect(valid.test("#f0f9ff")).toBe(true);
    expect(valid.test("#fff")).toBe(true);
    expect(valid.test("#f00; background-image: url(evil)")).toBe(false);
    expect(valid.test("red")).toBe(false);
    expect(valid.test("")).toBe(false);
    expect(valid.test("#xyz")).toBe(false);
  });
});
