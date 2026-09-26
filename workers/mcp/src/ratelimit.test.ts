import { describe, expect, it, vi } from "vitest";
import { RATE_LIMIT_PERIOD_SECONDS, type RateLimiter, withRateLimit } from "./ratelimit";

const ctx = {} as ExecutionContext;

function limiter(success: boolean) {
  return { limit: vi.fn(async () => ({ success })) } satisfies RateLimiter;
}

function request(ip?: string) {
  return new Request("https://mcp.freeappstore.online/", { headers: ip ? { "CF-Connecting-IP": ip } : {} });
}

describe("withRateLimit", () => {
  it("passes the request through when under the limit", async () => {
    const inner = vi.fn(async () => new Response("ok"));
    const env = { MCP_RATE_LIMIT: limiter(true) };

    const res = await withRateLimit(inner)(request("1.2.3.4"), env, ctx);

    expect(res.status).toBe(200);
    expect(await res.text()).toBe("ok");
    expect(inner).toHaveBeenCalledOnce();
    expect(env.MCP_RATE_LIMIT.limit).toHaveBeenCalledWith({ key: "mcp:1.2.3.4" });
  });

  it("returns 429 with Retry-After and never calls the handler when over the limit", async () => {
    const inner = vi.fn(async () => new Response("ok"));
    const env = { MCP_RATE_LIMIT: limiter(false) };

    const res = await withRateLimit(inner)(request("1.2.3.4"), env, ctx);

    expect(res.status).toBe(429);
    expect(res.headers.get("Retry-After")).toBe(String(RATE_LIMIT_PERIOD_SECONDS));
    expect(await res.json()).toEqual({ error: "rate_limited", error_description: "Too many requests" });
    expect(inner).not.toHaveBeenCalled();
  });

  it("limits unauthenticated requests too: the check runs before any routing or auth", async () => {
    const inner = vi.fn(async () => new Response("unauthorized", { status: 401 }));
    const env = { MCP_RATE_LIMIT: limiter(false) };

    const res = await withRateLimit(inner)(new Request("https://mcp.freeappstore.online/mcp"), env, ctx);

    expect(res.status).toBe(429);
    expect(env.MCP_RATE_LIMIT.limit).toHaveBeenCalledWith({ key: "mcp:unknown" });
  });

  it("is a no-op when the binding is absent (wrangler dev, tests)", async () => {
    const inner = vi.fn(async () => new Response("ok"));

    const res = await withRateLimit(inner)(request("1.2.3.4"), {}, ctx);

    expect(res.status).toBe(200);
    expect(inner).toHaveBeenCalledOnce();
  });
});
