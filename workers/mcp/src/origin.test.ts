import { describe, expect, it } from "vitest";
import { isAllowedBrowserOrigin, withOriginCheck } from "./origin.js";

const upstream = (req: Request) =>
  new Response("ok", {
    headers: {
      "Access-Control-Allow-Origin": req.headers.get("Origin") ?? "*",
      "Access-Control-Allow-Headers": "Authorization, *",
      "Content-Type": "text/plain",
    },
  });
const handler = withOriginCheck<object>((req) => upstream(req));
const call = (init: RequestInit) =>
  handler(new Request("https://mcp.freeappstore.online/mcp", init), {}, {} as ExecutionContext);

describe("isAllowedBrowserOrigin (#524)", () => {
  it.each([
    "https://freeappstore.online",
    "https://console.freeappstore.online",
    "https://claude.ai",
    "http://localhost:6274",
    "http://127.0.0.1:3000",
  ])("allows %s", (o) => expect(isAllowedBrowserOrigin(o)).toBe(true));

  it.each([
    "https://evil.example",
    "https://notes.freeappstore.online",
    "https://freeappstore.online.evil.example",
    "http://freeappstore.online",
    "https://localhost.evil.example",
    "null",
    "",
  ])("refuses %s", (o) => expect(isAllowedBrowserOrigin(o)).toBe(false));
});

describe("withOriginCheck", () => {
  it("refuses a preflight from an unlisted origin", async () => {
    const res = await call({ method: "OPTIONS", headers: { Origin: "https://evil.example" } });
    expect(res.status).toBe(403);
    expect(res.headers.get("Access-Control-Allow-Origin")).toBeNull();
  });

  it("strips CORS headers from a non-preflight response to an unlisted origin", async () => {
    const res = await call({ method: "POST", headers: { Origin: "https://evil.example" } });
    expect(res.status).toBe(200);
    expect(res.headers.get("Access-Control-Allow-Origin")).toBeNull();
    expect(res.headers.get("Access-Control-Allow-Headers")).toBeNull();
    expect(res.headers.get("Content-Type")).toBe("text/plain");
  });

  it("leaves a listed origin untouched", async () => {
    const res = await call({ method: "OPTIONS", headers: { Origin: "https://claude.ai" } });
    expect(res.headers.get("Access-Control-Allow-Origin")).toBe("https://claude.ai");
  });

  it("leaves a request with no Origin untouched", async () => {
    const res = await call({ method: "POST" });
    expect(res.status).toBe(200);
    expect(res.headers.get("Access-Control-Allow-Origin")).toBe("*");
  });
});
