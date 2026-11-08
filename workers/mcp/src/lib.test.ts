import { describe, expect, it } from "vitest";
import { legacySessionPrefix, ownsSession, sessionPrefix } from "./lib.js";

describe("sessionPrefix (#576)", () => {
  it("differs for long ids sharing their first 24 chars", async () => {
    const a = "1234567890123456789012345-a";
    const b = "1234567890123456789012345-b";
    expect(await sessionPrefix(a)).not.toBe(await sessionPrefix(b));
    expect(await ownsSession(a, `${await sessionPrefix(b)}x`)).toBe(false);
  });

  it("owns hashed and legacy sessions, rejects unsafe ids", async () => {
    expect(await ownsSession("u1", `${await sessionPrefix("u1")}abc`)).toBe(true);
    expect(await ownsSession("u1", `${legacySessionPrefix("u1")}abc`)).toBe(true);
    expect(await ownsSession("u1", `${await sessionPrefix("u1")}a/../b`)).toBe(false);
  });
});
