import { describe, expect, it } from "vitest";
import { formatAgentActivity, formatAgentStatus } from "./agent-observability.js";

describe("MCP agent status formatting", () => {
  it("shows live worker state and bounded sanitized detail", () => {
    const rendered = formatAgentStatus("mcp-user-session", {
      appId: null,
      messageCount: 66,
      devStatus: { state: "working", detail: `Building with Bearer secret-token and ${"x".repeat(36)}` },
    });

    expect(rendered).toContain("Status: working");
    expect(rendered).toContain("Messages: 66");
    expect(rendered).not.toContain("secret-token");
    expect(rendered).not.toContain("x".repeat(36));
  });

  it("reports unknown if an older backend omits devStatus", () => {
    expect(formatAgentStatus("session", {})).toContain("Status: unknown");
  });
});

describe("MCP agent activity formatting", () => {
  it("summarizes actual tool_result rows without exposing result payloads", () => {
    const rendered = formatAgentActivity("session", [
      {
        role: "assistant",
        content: "",
        toolCalls: [
          { id: "write-1", name: "write_file", input: { path: "src/App.tsx" } },
          { id: "deploy-1", name: "deploy", input: { id: "pitstop-log" } },
        ],
      },
      {
        role: "tool_result",
        content: "",
        toolResults: [
          { id: "write-1", content: "Wrote file: src/App.tsx\nconst secret = 'sk-12345678901234567890';", isError: false },
          { id: "deploy-1", content: "Deploy FAILED: private deployment detail", isError: true },
        ],
      },
    ]);

    expect(rendered).toContain("write_file: completed");
    expect(rendered).toContain("deploy: reported an error");
    expect(rendered).not.toContain("const secret");
    expect(rendered).not.toContain("private deployment detail");
    expect(rendered).not.toContain("sk-12345678901234567890");
  });

  it("bounds the requested history and describes missing outcomes honestly", () => {
    const rendered = formatAgentActivity("session", [
      { role: "assistant", toolCalls: [{ id: "missing", name: "create_app" }] },
      { role: "tool_result", content: "", toolResults: [] },
      { role: "user", content: "next" },
    ], 2);

    expect(rendered).toContain("3 messages, showing 2");
    expect(rendered).toContain("No result details recorded.");
    expect(rendered).not.toContain("[agent → tools]");
  });
});
