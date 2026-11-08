import { describe, expect, it } from "vitest";
import { reportsRoutes } from "./reports";

describe("GET /test-report (#572)", () => {
  it("serves sandboxed with nosniff", async () => {
    const env = { CREATORS: { get: async () => "<html>report</html>" } };
    const url = new URL("https://admin.freeappstore.online/test-report");
    const res = (await reportsRoutes({ request: new Request(url), env, url } as never)) as Response;
    expect(res.headers.get("Content-Security-Policy")).toBe("sandbox");
    expect(res.headers.get("X-Content-Type-Options")).toBe("nosniff");
  });
});
