import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { DeployLog } from "./DeployLog";

describe("DeployLog", () => {
  it.each([
    ["provisioning", "10%"], ["pushing", "50%"], ["building", "70%"],
  ])("shows active progress for %s", (phase, progress) => {
    const html = renderToStaticMarkup(<DeployLog state={{ phase }} />);
    expect(html).toContain(progress);
    expect(html).toContain("animate-spin");
    expect(html).toContain("stroke-accent");
    expect(html).not.toContain("style=");
  });
  it("shows completed steps and the live preview link", () => {
    const html = renderToStaticMarkup(<DeployLog state={{ phase: "live", appUrl: "https://example.com" }} />);
    expect(html).toContain("Preview is live!");
    expect(html).toContain('href="https://example.com"');
    expect(html).toContain("stroke-success");
    expect(html).toContain('stroke-dashoffset="0"');
    expect(html).not.toContain("animate-spin");
  });
  it("shows skipped and failed provisioning steps with warning and danger colours", () => {
    const html = renderToStaticMarkup(<DeployLog state={{ phase: "error", error: "Build failed", steps: [
      { name: "GitHub repo", status: "skip" }, { name: "CF Pages", status: "failed" },
    ] }} />);
    expect(html).toContain("(exists)");
    expect(html).toContain("text-warning");
    expect(html).toContain("text-danger");
    expect(html).toContain("stroke-danger");
    expect(html).toContain("Deploy failed");
    expect(html).toContain("Build failed");
    expect(html).not.toContain("Preview is live!");
  });
});
