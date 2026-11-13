import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { Profile } from "./Profile";

vi.mock("../components/Nav", () => ({ Nav: () => <nav>Studio navigation</nav> }));
vi.mock("../../AccountSettings", () => ({ AccountSettings: () => <div>Account actions</div> }));
vi.mock("../components/AISettings", () => ({ AISettings: () => <div>Vault settings</div> }));
vi.mock("../hooks/useAuth", () => ({ useAuth: () => ({ user: { id: "1", login: "Creator" }, loading: false }) }));
vi.mock("../hooks/useSpeech", () => ({ useSpeech: () => ({ supported: false }) }));
vi.mock("../lib/theme", () => ({ useTheme: () => ({ pref: "dark", set: () => {} }) }));
vi.mock("../lib/text-size", () => ({ useTextSize: () => ({ size: "default", setSize: () => {} }) }));
vi.mock("../lib/ai-keys", () => ({ PROVIDERS: [], MODEL_OPTIONS: {}, getDefaultProvider: () => "openai", getDefaultModel: () => "gpt-4o" }));
vi.stubGlobal("window", {});

describe("Profile", () => {
  it("renders profile appearance and vault settings", () => {
    const html = renderToStaticMarkup(<Profile />);
    expect(html).toContain("Creator");
    expect(html).toContain("Appearance");
    expect(html).toContain("Vault settings");
    expect(html).toContain("Account actions");
    expect(html).toContain("Text Size");
    expect(html).toContain("bg-accent");
    expect(html).not.toContain("style=");
  });
});
