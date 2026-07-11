import { describe, expect, it } from "vitest";
import worker from "./index";

describe("agent key resolution", () => {
  it("calls the platform backend through the internal service-binding host", async () => {
    let platformUrl = "";
    let forwardedBody: { aiConfig?: { apiKey?: string; provider?: string; model?: string } } | null = null;

    const env = {
      STORE: "apps",
      PLATFORM: {
        fetch: async (input: RequestInfo | URL) => {
          platformUrl = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
          return new Response(JSON.stringify({ key: "sk-platform", provider: "anthropic", model: "claude-sonnet-4-6", source: "grant" }), {
            headers: { "Content-Type": "application/json" },
          });
        },
      },
      SESSION: {
        idFromName: (name: string) => name,
        get: () => ({
          fetch: async (request: Request) => {
            forwardedBody = await request.json();
            return new Response(JSON.stringify({ ok: true }), { headers: { "Content-Type": "application/json" } });
          },
        }),
      },
    };

    const res = await worker.fetch(
      new Request("https://agent.freeappstore.online/session/s1/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: "Bearer user-token" },
        body: JSON.stringify({ message: "build", aiConfig: { provider: "anthropic", model: "claude-sonnet-4-6" } }),
      }),
      env as unknown as Parameters<typeof worker.fetch>[1],
    );

    expect(res.status).toBe(200);
    expect(platformUrl).toBe("https://backend/v1/keys/resolve-agent/anthropic");
    expect(forwardedBody?.aiConfig?.apiKey).toBe("sk-platform");
  });
});
