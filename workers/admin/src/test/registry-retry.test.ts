// Registry-write retry behavior under concurrent provisions.
//
// Background: src/publish.ts updates the storefront's registry.json via the
// GitHub Contents API (PUT). The PUT requires the file's current `sha`. If
// two provisions race, the second one's `sha` is stale and GitHub returns
// 409 Conflict. Now that PAS provisioning calls fas/admin via a service
// binding, the race is more likely — so writeRegistryWithRetry retries
// once on 409 by re-fetching (fresh sha + fresh content) and re-PUTting.

import { describe, expect, it, vi } from "vitest";
import { writeRegistryWithRetry } from "../publish";

// Minimal request and config — only the fields the registry write reads.
const req = {
  id: "calendar",
  name: "Calendar",
  category: "utilities",
  icon: "&#128197;",
  iconBg: "#f0f9ff",
  description: "Simple calendar",
  store: "apps" as const,
};

const config: any = {
  org: "freeappstore-online",
  domain: "freeappstore.online",
  storeRepo: "freeappstore",
  registryKey: "apps",
  developer: "FreeAppStore",
  templateRepo: "template-standalone",
  zoneIdFromEnv: () => "",
};

const subdomain = "calendar.freeappstore.online";

/** Build the base64-encoded body GitHub returns from GET /contents — registry
 * JSON with the apps array. Pass entries already present. */
function encodeFile(items: any[], sha = "sha-1") {
  const raw = JSON.stringify({ apps: items }, null, 2);
  // Mirror btoa(utf8-encoded-bytes) from publish.ts encodeRegistry.
  const bytes = new TextEncoder().encode(raw);
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return { content: btoa(bin), sha };
}

describe("writeRegistryWithRetry", () => {
  it("200 first try → 1 GET + 1 PUT, status ok", async () => {
    const gh = vi.fn(async (path: string, method?: string) => {
      if (method === undefined || method === "GET") {
        return encodeFile([], "sha-1");
      }
      if (method === "PUT") {
        // Successful PUT — GitHub returns the new commit + content
        return { content: { sha: "sha-2" }, __status: 200 };
      }
      throw new Error(`unexpected ${method} ${path}`);
    });

    const step = await writeRegistryWithRetry(gh, req, config, subdomain);

    expect(step).toEqual({ name: "Store registry", status: "ok", detail: "Added Calendar" });
    expect(gh).toHaveBeenCalledTimes(2); // 1 GET + 1 PUT
    expect(gh.mock.calls[0][1]).toBeUndefined(); // first call is a GET (default method)
    expect(gh.mock.calls[1][1]).toBe("PUT");
  });

  it("409 then 200 → 2 GETs + 2 PUTs, status ok", async () => {
    let putCount = 0;
    const gh = vi.fn(async (_path: string, method?: string) => {
      if (method === undefined || method === "GET") {
        // First GET returns sha-1; second GET returns fresh sha-2 (someone
        // else's write bumped it).
        const sha = putCount === 0 ? "sha-1" : "sha-2";
        return encodeFile([], sha);
      }
      if (method === "PUT") {
        putCount++;
        if (putCount === 1) {
          return { message: "is at ... but expected ...", __status: 409 };
        }
        return { content: { sha: "sha-3" }, __status: 200 };
      }
    });

    const step = await writeRegistryWithRetry(gh, req, config, subdomain);

    expect(step).toEqual({ name: "Store registry", status: "ok", detail: "Added Calendar" });
    // 1 GET + 1 PUT(409) + 1 GET (retry) + 1 PUT(200) = 4 calls
    expect(gh).toHaveBeenCalledTimes(4);
  });

  it("409 then 409 → 2 PUT attempts, fail step with contended-twice detail", async () => {
    const gh = vi.fn(async (_path: string, method?: string) => {
      if (method === undefined || method === "GET") {
        return encodeFile([], "sha-1");
      }
      if (method === "PUT") {
        return { message: "is at ... but expected ...", __status: 409 };
      }
    });

    const step = await writeRegistryWithRetry(gh, req, config, subdomain);

    expect(step.name).toBe("Store registry");
    expect(step.status).toBe("fail");
    expect(step.detail).toMatch(/contended twice/i);
    // 1 GET + 1 PUT(409) + 1 GET + 1 PUT(409) = 4 calls (2 PUT attempts).
    expect(gh).toHaveBeenCalledTimes(4);
    // Two of those calls are PUTs.
    const putCalls = gh.mock.calls.filter((c) => c[1] === "PUT");
    expect(putCalls).toHaveLength(2);
  });

  it("rare race won: 409 then concurrent writer added our entry → skip with 'Added by a concurrent provision'", async () => {
    let getCount = 0;
    const gh = vi.fn(async (_path: string, method?: string) => {
      if (method === undefined || method === "GET") {
        getCount++;
        // First GET: empty. After our PUT 409, the second GET reflects the
        // concurrent writer having already added our id.
        if (getCount === 1) return encodeFile([], "sha-1");
        return encodeFile([{ id: "calendar", name: "Calendar" }], "sha-2");
      }
      if (method === "PUT") {
        return { message: "is at ... but expected ...", __status: 409 };
      }
    });

    const step = await writeRegistryWithRetry(gh, req, config, subdomain);

    expect(step).toEqual({
      name: "Store registry",
      status: "skip",
      detail: "Added by a concurrent provision",
    });
    // 1 GET + 1 PUT(409) + 1 GET (now sees our entry, skips PUT) = 3 calls.
    expect(gh).toHaveBeenCalledTimes(3);
  });

  it("already-listed on first try → skip with 'Already listed', no PUT", async () => {
    const gh = vi.fn(async (_path: string, method?: string) => {
      if (method === undefined || method === "GET") {
        return encodeFile([{ id: "calendar", name: "Calendar" }], "sha-1");
      }
      return {};
    });

    const step = await writeRegistryWithRetry(gh, req, config, subdomain);

    expect(step).toEqual({ name: "Store registry", status: "skip", detail: "Already listed" });
    // Only 1 GET, no PUT.
    expect(gh).toHaveBeenCalledTimes(1);
  });

  it("non-409 PUT failure → fail step, no retry", async () => {
    const gh = vi.fn(async (_path: string, method?: string) => {
      if (method === undefined || method === "GET") {
        return encodeFile([], "sha-1");
      }
      if (method === "PUT") {
        return { message: "Bad credentials", __status: 401 };
      }
    });

    const step = await writeRegistryWithRetry(gh, req, config, subdomain);

    expect(step.name).toBe("Store registry");
    expect(step.status).toBe("fail");
    expect(step.detail).toBe("Bad credentials");
    // 1 GET + 1 PUT, no retry.
    expect(gh).toHaveBeenCalledTimes(2);
  });

  it("missing content on first GET → fail step", async () => {
    const gh = vi.fn(async () => ({ message: "Not Found", __status: 404 }));

    const step = await writeRegistryWithRetry(gh, req, config, subdomain);

    expect(step).toEqual({
      name: "Store registry",
      status: "fail",
      detail: "Could not read registry.json",
    });
    expect(gh).toHaveBeenCalledTimes(1);
  });
});
