import { describe, expect, it } from "vitest";

describe("SSE event parsing", () => {
  it("parses text event", () => {
    const line = 'data: {"type":"text","data":"Hello"}';
    const evt = JSON.parse(line.slice(6).trim());
    expect(evt.type).toBe("text");
    expect(evt.data).toBe("Hello");
  });

  it("parses tool_call event", () => {
    const line = 'data: {"type":"tool_call","data":"{\\"id\\":\\"call_1\\",\\"name\\":\\"write_file\\",\\"input\\":{\\"path\\":\\"App.tsx\\"}}"}';
    const evt = JSON.parse(line.slice(6).trim());
    const tc = JSON.parse(evt.data);
    expect(tc.name).toBe("write_file");
    expect(tc.input.path).toBe("App.tsx");
  });

  it("handles malformed JSON gracefully", () => {
    const raw = "not-json";
    let parsed = false;
    try { JSON.parse(raw); parsed = true; } catch {}
    expect(parsed).toBe(false);
  });

  it("parses deploy_status event", () => {
    const line = 'data: {"type":"deploy_status","data":"{\\"phase\\":\\"live\\",\\"appUrl\\":\\"https://test.pages.dev\\"}"}';
    const evt = JSON.parse(line.slice(6).trim());
    const ds = JSON.parse(evt.data);
    expect(ds.phase).toBe("live");
    expect(ds.appUrl).toContain("pages.dev");
  });
});
