import { describe, expect, it, vi, beforeEach } from "vitest";

beforeEach(() => {
  vi.stubGlobal("localStorage", {
    store: new Map<string, string>(),
    getItem(k: string) { return this.store.get(k) ?? null; },
    setItem(k: string, v: string) { this.store.set(k, v); },
    removeItem(k: string) { this.store.delete(k); },
  });
});

describe("getSession", () => {
  it("returns null when no session stored", async () => {
    const { getSession } = await import("../lib/api");
    expect(getSession()).toBeNull();
  });

  it("returns session from localStorage", async () => {
    const session = { token: "tok", user: { id: "gh:1", login: "alice", avatarUrl: null } };
    localStorage.setItem("fas:session", JSON.stringify(session));
    const { getSession } = await import("../lib/api");
    expect(getSession()?.user.login).toBe("alice");
  });
});

describe("getSignInUrl", () => {
  it("builds correct v1 auth URL", async () => {
    const { getSignInUrl } = await import("../lib/api");
    const url = getSignInUrl("https://create.freeappstore.online");
    expect(url).toContain("/v1/auth/github/start");
    expect(url).toContain("app_id=create");
    expect(url).toContain("return_to=");
  });
});

describe("signOut", () => {
  it("clears session from localStorage", async () => {
    localStorage.setItem("fas:session", '{"token":"x","user":{}}');
    const { signOut } = await import("../lib/api");
    signOut();
    expect(localStorage.getItem("fas:session")).toBeNull();
  });
});
