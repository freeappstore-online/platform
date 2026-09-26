import { describe, expect, it } from "vitest";
import { hasScope, parseScopes } from "./safety";

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
