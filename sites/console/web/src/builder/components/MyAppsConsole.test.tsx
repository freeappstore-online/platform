import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { MyAppsConsole } from "./MyAppsConsole";

vi.mock("../hooks/useAppStatuses", () => ({ useAppStatuses: () => new Map() }));
vi.stubGlobal("localStorage", { getItem: () => null });

describe("MyAppsConsole", () => {
  it("renders an empty app list", () => {
    const html = renderToStaticMarkup(<MyAppsConsole projects={[]} loading={false} error={false} onRetry={() => {}} currentId={null} onSelect={() => {}} onNewChat={() => {}} />);
    expect(html).toContain("My Apps");
    expect(html).toContain("Build your first app");
    expect(html).not.toContain("style=");
  });
  it("renders a deployed current project", () => {
    const html = renderToStaticMarkup(<MyAppsConsole projects={[{ id: "one", name: "Demo", appId: "demo", deployed: true, createdAt: "", updatedAt: 0 }]} loading={false} error={false} onRetry={() => {}} currentId="one" onSelect={() => {}} onNewChat={() => {}} />);
    expect(html).toContain("demo.freeappstore.online");
    expect(html).toContain("bg-success");
    expect(html).toContain("border-accent");
    expect(html).not.toContain("style=");
  });
});
