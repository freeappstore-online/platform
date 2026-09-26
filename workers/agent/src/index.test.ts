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

describe("the funding source of a turn (#16)", () => {
  /** POST /chat through the worker; returns what the session DO received and the platform calls. */
  async function chat(body: Record<string, unknown>, resolved: Record<string, unknown> | null) {
    const platformCalls: string[] = [];
    let forwarded: Record<string, any> = {};
    const env = {
      STORE: "apps",
      PLATFORM: {
        fetch: async (input: RequestInfo | URL) => {
          platformCalls.push(String(input));
          return resolved ? Response.json(resolved) : new Response("nope", { status: 500 });
        },
      },
      SESSION: {
        idFromName: (name: string) => name,
        get: () => ({
          fetch: async (request: Request) => {
            forwarded = await request.json();
            return Response.json({ ok: true });
          },
        }),
      },
    };
    await worker.fetch(
      new Request("https://agent.freeappstore.online/session/s1/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: "Bearer user-token" },
        body: JSON.stringify(body),
      }),
      env as unknown as Parameters<typeof worker.fetch>[1],
    );
    return { forwarded, platformCalls };
  }

  const aiConfig = { provider: "anthropic", model: "claude-sonnet-4-6" };

  it("records the platform's answer: user vault, admin key or grant", async () => {
    for (const source of ["vault_user", "vault_admin", "grant"]) {
      const { forwarded } = await chat({ message: "build", aiConfig }, { key: "sk-x", provider: "anthropic", source });
      expect(forwarded.aiSource).toBe(source);
    }
  });

  it("a key the browser sent is browser_key, and the platform isn't asked", async () => {
    const { forwarded, platformCalls } = await chat({ message: "build", aiConfig: { ...aiConfig, apiKey: "sk-browser" } }, null);
    expect(forwarded.aiSource).toBe("browser_key");
    expect(platformCalls).toEqual([]);
  });

  it("no key anywhere is none, including when the lookup fails", async () => {
    expect((await chat({ message: "build", aiConfig }, { key: null, source: "none" })).forwarded.aiSource).toBe("none");
    expect((await chat({ message: "build", aiConfig }, null)).forwarded.aiSource).toBe("none");
  });

  it("a client can't claim its own source, and an unknown one becomes none", async () => {
    const claimed = await chat({ message: "build", aiConfig, aiSource: "grant" }, { key: null, source: "none" });
    expect(claimed.forwarded.aiSource).toBe("none");
    const unknown = await chat({ message: "build", aiConfig }, { key: "sk-x", source: "something-new" });
    expect(unknown.forwarded.aiSource).toBe("none");
  });

  it("the source is a label, never the key", async () => {
    const { forwarded } = await chat(
      { message: "build", aiConfig },
      { key: "sk-secret-grant-key", provider: "anthropic", source: "grant" },
    );
    expect(forwarded.aiSource).toBe("grant");
    expect(JSON.stringify(forwarded.aiSource)).not.toContain("sk-");
  });
});
