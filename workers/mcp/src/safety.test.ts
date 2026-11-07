import { describe, expect, it, vi } from "vitest";
import { audit, auditKey, hasScope, listAuditEvents, parseScopes, requirePermission } from "./safety";

// #61 item 3: an unspecified or unrecognised scope must never imply `destructive`.
describe("parseScopes", () => {
  it.each([
    ["undefined", undefined],
    ["null", null],
    ["empty string", ""],
    ["empty array (how the OAuth library passes a no-scope request)", []],
    ["only unknown scopes", "openid profile"],
  ])("defaults to read, write, runtime for %s", (_label, value) => {
    expect(parseScopes(value)).toEqual(["read", "write", "runtime"]);
  });

  it("grants destructive only when explicitly requested", () => {
    expect(parseScopes("read destructive")).toEqual(["read", "destructive"]);
    expect(parseScopes(["write", "destructive"])).toEqual(["write", "destructive"]);
  });

  it("keeps known scopes, drops unknown ones and duplicates", () => {
    expect(parseScopes("read,openid read")).toEqual(["read"]);
  });
});

describe("hasScope", () => {
  const ctx = (scopes: string[] | null | undefined) => ({ env: {}, scopes });

  it("does not grant destructive to a context with no recorded scopes", () => {
    expect(hasScope(ctx(null), "destructive")).toBe(false);
    expect(hasScope(ctx(undefined), "destructive")).toBe(false);
    expect(hasScope(ctx(null), "write")).toBe(true);
  });

  it("honours an explicit read-only grant", () => {
    expect(hasScope(ctx(["read"]), "read")).toBe(true);
    expect(hasScope(ctx(["read"]), "write")).toBe(false);
  });
});

describe("requirePermission", () => {
  it("flags a denial as a tool error", async () => {
    const denied = await requirePermission({ env: {}, scopes: ["read"] }, "write", "update_files");
    expect(denied?.isError).toBe(true);
    const readOnly = await requirePermission({ env: { MCP_READ_ONLY: "1" } }, "write", "create_app");
    expect(readOnly?.isError).toBe(true);
    expect(await requirePermission({ env: {} }, "read", "list_apps")).toBeNull();
  });
});

// #555: KV lists ascending and applies the limit first; the newest events must come back.
describe("audit log order", () => {
  /** A KV that, like Cloudflare's, lists keys in ascending order and truncates at `limit`. */
  function fakeKv() {
    const store = new Map<string, string>();
    return {
      async put(key: string, value: string) { store.set(key, value); },
      async get(key: string) { return store.get(key) ?? null; },
      async list({ prefix, limit }: { prefix: string; limit: number }) {
        return { keys: [...store.keys()].filter((k) => k.startsWith(prefix)).sort().slice(0, limit).map((name) => ({ name })) };
      },
    } as unknown as KVNamespace;
  }

  it("sorts newer keys first", () => {
    expect(auditKey("gh:1", 2_000, "a") < auditKey("gh:1", 1_000, "a")).toBe(true);
  });

  it("returns the newest events when there are more than the limit", async () => {
    const ctx = { env: { OAUTH_KV: fakeKv() }, subject: "gh:1" };
    let now = 1_800_000_000_000;
    const spy = vi.spyOn(Date, "now").mockImplementation(() => now);
    for (let i = 0; i < 5; i++) {
      now += 1000;
      await audit(ctx, { tool: "t", n: i });
    }
    spy.mockRestore();
    const rows = (await listAuditEvents(ctx, 2)) as Array<{ n: number }>;
    expect(rows.map((r) => r.n)).toEqual([4, 3]);
  });
});
