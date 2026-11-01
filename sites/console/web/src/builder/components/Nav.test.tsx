import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it, vi } from "vitest";
import { Nav } from "./Nav";
import { AuthContext } from "../hooks/useAuth";

vi.mock("../lib/theme", () => ({ useTheme: () => ({ pref: "system", cycle: () => {} }) }));

describe("Nav", () => {
  it("offers sign-in and theme controls when signed out", () => {
    const html = renderToStaticMarkup(<MemoryRouter><Nav /></MemoryRouter>);
    expect(html).toContain("Sign in");
    expect(html).toContain('aria-label="Theme: system"');
    expect(html).toContain('aria-label="Menu"');
    expect(html).toContain('href="https://freeappstore.online/docs"');
    expect(html).not.toContain("style=");
  });
  it("shows the signed-in user's avatar", () => {
    const user = { id: "1", login: "creator", avatarUrl: "https://example.com/avatar.png" };
    const html = renderToStaticMarkup(<MemoryRouter><AuthContext.Provider value={{ user, loading: false, signIn: () => {}, signOut: () => {} }}><Nav /></AuthContext.Provider></MemoryRouter>);
    expect(html).toContain('alt="creator"');
    expect(html).toContain("border-line");
    expect(html).not.toContain("Sign in");
    expect(html).not.toContain("style=");
  });
});
