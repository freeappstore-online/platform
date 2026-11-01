import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it, vi } from "vitest";
import { Admin, Sparkline } from "./Admin";

vi.mock("../components/Nav", () => ({ Nav: () => <nav>Studio navigation</nav> }));
vi.mock("../hooks/useAuth", () => ({ useAuth: () => ({ user: null, loading: false }) }));

describe("Admin", () => {
  it("renders the admin access gate", () => {
    const html = renderToStaticMarkup(<MemoryRouter><Admin /></MemoryRouter>);
    expect(html).toContain("Admin access required.");
    expect(html).not.toContain("style=");
  });
  it("renders data-driven sparkline dimensions without inline styles", () => {
    const html = renderToStaticMarkup(<Sparkline height={20} series={[{ t: "day1", views: 10 }, { t: "day2", views: 0 }]} />);
    expect(html).toContain('viewBox="0 0 20 20"');
    expect(html).toContain('height="20"');
    expect(html).toContain('height="1"');
    expect(html).toContain("10 page views over 2 days");
    expect(html).not.toContain("style=");
  });
});
