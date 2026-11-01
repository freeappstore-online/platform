import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { AISettings } from "./AISettings";
import { hasLocalKeys } from "../lib/ai-keys";

vi.mock("../lib/ai-keys", async (importOriginal) => ({
  ...await importOriginal<typeof import("../lib/ai-keys")>(),
  hasLocalKeys: vi.fn(() => false),
}));

describe("AISettings", () => {
  it.each([false, true])("renders local migration availability=%s", (local) => {
    vi.mocked(hasLocalKeys).mockReturnValue(local);
    const html = renderToStaticMarkup(<AISettings />);
    expect(html).toContain("Loading keys...");
    expect(html.includes("Migrate to vault")).toBe(local);
    if (local) {
      expect(html).toContain("border-warning");
      expect(html).toContain("disabled:opacity-60");
    }
    expect(html).not.toContain("style=");
  });
});
