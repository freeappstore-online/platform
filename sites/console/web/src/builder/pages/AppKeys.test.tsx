import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it, vi } from "vitest";
import { AppKeys } from "./AppKeys";

vi.mock("../components/Nav", () => ({ Nav: () => <nav>Studio navigation</nav> }));
vi.mock("../hooks/useAuth", () => ({ useAuth: () => ({ user: null, loading: false, signIn: () => {} }) }));

describe("AppKeys", () => {
  it("renders sign-in instructions", () => {
    const html = renderToStaticMarkup(<MemoryRouter><AppKeys /></MemoryRouter>);
    expect(html).toContain("Sign in to manage this app");
    expect(html).toContain("Sign in with GitHub");
    expect(html).not.toContain("style=");
  });
});
