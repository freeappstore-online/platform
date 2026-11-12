import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { Nav } from "./Nav";
import { AuthContext } from "../hooks/useAuth";

vi.mock("@freeappstore/sdk/ui", () => ({ ThemeToggle: () => <button>Theme</button> }));

describe("Nav", () => {
  it("offers the console sections and sign-in when signed out", () => {
    const html = renderToStaticMarkup(<Nav />);
    expect(html).toContain("Sign in");
    expect(html).toContain('href="/"');
    expect(html).toContain('href="/build"');
    expect(html).toContain('href="/publish"');
    expect(html).toContain('href="https://freeappstore.online/docs"');
    expect(html).not.toContain("style=");
  });
  it("shows the signed-in user's account menu button", () => {
    const user = { id: "1", login: "creator", avatarUrl: "https://example.com/avatar.png" };
    const html = renderToStaticMarkup(<AuthContext.Provider value={{ user, loading: false, signIn: () => {}, signOut: () => {} }}><Nav /></AuthContext.Provider>);
    expect(html).toContain('alt="creator"');
    expect(html).toContain('aria-label="Account menu"');
    expect(html).not.toContain("Sign in");
    expect(html).not.toContain("style=");
  });
});
