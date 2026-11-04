import { describe, expect, it } from "vitest";
import { getConfig } from "./config";
import { getSystemPrompt } from "./template";

const prompt = getSystemPrompt(getConfig("apps"));
describe("effective builder prompt contract (#377)", () => {
  it("allows app-owned screens, styles and custom frames", () => {
    for (const text of [
      "custom frame is allowed",
      "index.css as needed",
      "labelled navigation",
      "44px touch targets",
      "profile route in both auth states",
    ])
      expect(prompt).toContain(text);
    expect(prompt).not.toMatch(/Keep <Shell>.*as the root|You ONLY need to write|already correct|should NOT be rewritten/);
  });
  it("selects storage by ownership and validates saves", () => {
    for (const text of [
      "@freeappstore/sdk/persist",
      "ok/reason",
      "fas.kv",
      "public reads and owner writes",
      "ephemeral broadcast",
      "stale responses",
      "never delete user records",
    ])
      expect(prompt).toContain(text);
    expect(prompt).not.toMatch(/All data in localStorage|Store user data in localStorage|Keep simple\/throwaway apps on localStorage/);
  });
  it("distinguishes cached shell availability from connected features", () => {
    expect(prompt).toContain("account sync, proxy APIs and rooms require connectivity");
    expect(prompt).not.toContain("Must work offline after first load");
  });
  it("permits capability configuration while preserving locks and security", () => {
    for (const text of [
      "POST /session/:id/capabilities",
      "dryRun: true",
      "prerequisites",
      "without overwriting edited generated files",
      "write_file locks",
      "NO payments and NO ads",
      "CANNOT modify, deploy to, or push code to apps created by other users",
    ])
      expect(prompt).toContain(text);
  });
});
