import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { DeployStatusBar, type DeployStatusBarProps } from "./DeployStatusBar";

const props: DeployStatusBarProps = {
  isStreaming: false, deployState: null, onRetry: () => {}, onSwitchToChat: () => {},
  retryConfig: { provider: "openai", model: "test", apiKey: "", temperature: 0.7, maxTokens: 100 },
};
describe("DeployStatusBar", () => {
  it("hides when idle", () => {
    expect(renderToStaticMarkup(<DeployStatusBar {...props} />)).toBe("");
  });
  it("pulses while generating code", () => {
    const html = renderToStaticMarkup(<DeployStatusBar {...props} isStreaming />);
    expect(html).toContain("Building");
    expect(html).toContain("bg-warning");
    expect(html).toContain("animate-pulse");
  });
  it.each([
    ["provisioning", "Setting up"], ["pushing", "Pushing code"], ["building", "Building"],
    ["live", "Preview ready"], ["error", "Deploy failed"],
  ])("renders the %s state with token colours", (phase, label) => {
    const html = renderToStaticMarkup(<DeployStatusBar {...props} deployState={{ phase }} />);
    expect(html).toContain(label);
    if (phase === "live" || phase === "error") {
      expect(html).toContain(phase === "live" ? "bg-success" : "bg-danger");
      expect(html).not.toContain("animate-pulse");
    } else expect(html).toContain("bg-accent");
    expect(html).not.toContain("style=");
    expect(html).not.toContain("<style");
  });
  it("shows an active provisioning step", () => {
    const html = renderToStaticMarkup(<DeployStatusBar {...props} deployState={{ phase: "provisioning", steps: [{ name: "Provision repo", status: "active" }] }} />);
    expect(html).toContain("Provision repo");
  });
});
