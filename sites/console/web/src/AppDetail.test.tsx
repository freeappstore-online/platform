import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { AppDetail } from "./AppDetail";

describe("AppDetail", () => {
  it("renders app identity and navigation", () => {
    const html = renderToStaticMarkup(<AppDetail appId="demo" appName="Demo app" getToken={() => null} onBack={() => {}} onOpenInVibeCode={() => {}} />);
    expect(html).toContain("Demo app");
    expect(html).toContain("demo.freeappstore.online");
    expect(html).not.toContain("style=");
  });
});
