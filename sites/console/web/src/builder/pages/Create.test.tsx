import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it, vi } from "vitest";
import { Create } from "./Create";

vi.mock("../components/Nav", () => ({ Nav: () => <nav>Studio navigation</nav> }));
vi.mock("../hooks/useAuth", () => ({ useAuth: () => ({ user: null, loading: false, signIn: () => {} }) }));
vi.mock("../hooks/useAgent", () => ({ useAgent: () => ({ projects: [], messages: [], currentProjectId: null }) }));
vi.mock("../hooks/useSpeech", () => ({ useSpeech: () => ({ supported: false, enabled: false }) }));
vi.stubGlobal("localStorage", { getItem: () => null });

describe("Create", () => {
  it("renders the builder sign-in screen", () => {
    const html = renderToStaticMarkup(<MemoryRouter><Create /></MemoryRouter>);
    expect(html).toContain("VibeCode");
    expect(html).toContain("Sign in with GitHub to start");
    expect(html).not.toContain("style=");
  });
});
