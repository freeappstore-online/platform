import { describe, expect, it } from "vitest";
import { keyForPath } from "./index.js";

describe("keyForPath", () => {
  it("maps app KB paths by slug on the KB host", () => {
    expect(keyForPath("/timer/", "kb.freeappstore.online")).toBe("timer/index.html");
    expect(keyForPath("/timer/setup/", "kb.freeappstore.online")).toBe("timer/setup/index.html");
    expect(keyForPath("/timer/assets/app.css", "kb.freeappstore.online")).toBe("timer/assets/app.css");
  });

  it("maps the docs host root to the platform docs prefix", () => {
    expect(keyForPath("/", "docs.freeappstore.online")).toBe("platform/index.html");
    expect(keyForPath("/sdk/", "docs.freeappstore.online")).toBe("platform/sdk/index.html");
    expect(keyForPath("/cli/", "docs.freeappstore.online")).toBe("platform/cli/index.html");
  });

  it("rejects traversal attempts", () => {
    expect(keyForPath("/../secret", "kb.freeappstore.online")).toBeNull();
    expect(keyForPath("/../secret", "docs.freeappstore.online")).toBeNull();
  });
});
