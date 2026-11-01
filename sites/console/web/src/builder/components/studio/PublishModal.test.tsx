import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { PublishModal } from "./PublishModal";

describe("PublishModal", () => {
  it.each(["demo-app", "INVALID"])("renders publishing for %s with correct validation", (appId) => {
    const html = renderToStaticMarkup(<PublishModal appId={appId} appName="Demo" onClose={() => {}} onPublished={() => {}} />);
    expect(html).toContain("Publish to Store");
    expect(html).toContain("bg-paper");
    expect(html).toContain("One-line description");
    expect(html.includes('disabled=""')).toBe(appId === "INVALID");
    expect(html).not.toContain("style=");
  });
});
