import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { handlePublish } from "../publish.js";

const fakeEnv = {
  CF_ACCOUNT_ID: "fake-cf-account",
  CF_API_TOKEN: "fake-cf-token",
  GITHUB_TOKEN: "fake-gh-token",
  FAS_ZONE_ID: "fake-fas-zone",
  FGS_ZONE_ID: "fake-fgs-zone",
  BACKEND_FAS: undefined as Fetcher | undefined,
  ADMIN_PROVISION_TOKEN: undefined as string | undefined,
};

const baseRequest = {
  id: "test-app",
  name: "Test App",
  category: "utilities",
  icon: "🔧",
  iconBg: "#f0f0f0",
  description: "A test app",
  store: "apps" as const,
};

describe("handlePublish collaborator step", () => {
  let fetchCalls: { url: string; method: string; body?: any }[];
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    fetchCalls = [];
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input.toString();
      const method = init?.method || "GET";
      let body: any;
      if (init?.body) {
        try {
          body = JSON.parse(init.body as string);
        } catch {
          body = init.body;
        }
      }
      fetchCalls.push({ url, method, body });

      // Mock responses based on URL pattern
      if (url.includes("/repos/freeappstore-online/test-app") && method === "GET") {
        // Repo doesn't exist yet
        return new Response(JSON.stringify({ message: "Not Found" }), { status: 404 });
      }
      if (url.includes("/orgs/freeappstore-online/repos") && method === "POST") {
        // Create repo succeeds
        return new Response(JSON.stringify({ id: 123, name: "test-app" }));
      }
      if (url.includes("/collaborators/") && method === "PUT") {
        // Add collaborator succeeds
        return new Response(JSON.stringify({ id: 456, invitee: { login: "dev-user" } }));
      }
      if (url.includes("/dns_records")) {
        return new Response(JSON.stringify({ success: true }));
      }
      if (url.includes("/contents/registry.json")) {
        return new Response(
          JSON.stringify({
            content: Buffer.from(JSON.stringify({ apps: [] })).toString("base64"),
            sha: "abc123",
          }),
        );
      }
      if (url.includes("/contents/") && method === "PUT") {
        return new Response(JSON.stringify({ content: {} }));
      }

      return new Response(JSON.stringify({ success: true, result: {} }));
    }) as any;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("adds collaborator when creatorGithub is provided", async () => {
    const result = await handlePublish({ ...baseRequest, creatorGithub: "dev-user" }, fakeEnv);

    const collabCall = fetchCalls.find((c) => c.url.includes("/collaborators/dev-user") && c.method === "PUT");
    expect(collabCall).toBeDefined();
    expect(collabCall!.url).toContain("/repos/freeappstore-online/test-app/collaborators/dev-user");
    expect(collabCall!.body.permission).toBe("push");

    const collabStep = result.steps.find((s) => s.name === "Collaborator");
    expect(collabStep).toBeDefined();
    expect(collabStep!.status).toBe("ok");
    expect(collabStep!.detail).toContain("dev-user");
  });

  it("skips collaborator step when creatorGithub is not provided", async () => {
    const result = await handlePublish(baseRequest, fakeEnv);

    const collabCall = fetchCalls.find((c) => c.url.includes("/collaborators/") && c.method === "PUT");
    expect(collabCall).toBeUndefined();

    const collabStep = result.steps.find((s) => s.name === "Collaborator");
    expect(collabStep).toBeUndefined();
  });

  it("reports failure when collaborator API returns error", async () => {
    // Override fetch for this test
    const prevFetch = globalThis.fetch;
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input.toString();
      const method = init?.method || "GET";

      if (url.includes("/collaborators/") && method === "PUT") {
        return new Response(JSON.stringify({ message: "Validation Failed" }));
      }
      // Delegate everything else to the normal mock
      return (prevFetch as any)(input, init);
    }) as any;

    const result = await handlePublish({ ...baseRequest, creatorGithub: "bad-user" }, fakeEnv);

    const collabStep = result.steps.find((s) => s.name === "Collaborator");
    expect(collabStep).toBeDefined();
    expect(collabStep!.status).toBe("fail");
    expect(collabStep!.detail).toContain("Validation Failed");
  });
});
