import { describe, expect, it } from "vitest";
import { getConfig } from "./config";

describe("getConfig", () => {
  it("returns apps config for 'apps'", () => {
    const c = getConfig("apps");
    expect(c.store).toBe("apps");
    expect(c.org).toBe("freeappstore-online");
    expect(c.domain).toBe("freeappstore.online");
    expect(c.noun).toBe("app");
    expect(c.Noun).toBe("App");
    expect(c.nounPlural).toBe("apps");
    expect(c.storeRepo).toBe("platform");
    expect(c.registryPath).toBe("sites/storefront/registry.json");
    expect(c.storeName).toBe("FreeAppStore");
    expect(c.agentName).toBe("freeappstore-agent");
    expect(c.accentColor).toBe("#2563eb");
  });

  it("falls back to apps for unknown store", () => {
    const c = getConfig("unknown");
    expect(c.store).toBe("apps");
  });

  it("falls back to apps for empty string", () => {
    const c = getConfig("");
    expect(c.store).toBe("apps");
  });
});
