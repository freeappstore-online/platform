import { describe, expect, it, vi } from "vitest";
import { checkOwnership } from "./lib";

const API = "https://api.example";

function respond(status: number, body: unknown) {
  return vi.fn(async () =>
    new Response(typeof body === "string" ? body : JSON.stringify(body), { status }),
  ) as unknown as typeof fetch;
}

describe("checkOwnership (#72)", () => {
  it("owned when the app is in the caller's list", async () => {
    const f = respond(200, { apps: [{ id: "a" }, { id: "b" }] });
    expect(await checkOwnership(API, "tok", "b", f)).toEqual({ owned: true });
    expect(f).toHaveBeenCalledWith(`${API}/v1/apps/mine`, expect.objectContaining({
      headers: expect.objectContaining({ Authorization: "Bearer tok" }),
    }));
  });

  it("not owned only when the list is confirmed and lacks the app", async () => {
    expect(await checkOwnership(API, "tok", "c", respond(200, { apps: [{ id: "a" }] }))).toEqual({ owned: false });
    expect(await checkOwnership(API, "tok", "c", respond(200, { apps: [] }))).toEqual({ owned: false });
  });

  it("4xx is an error, not a denial", async () => {
    const r = await checkOwnership(API, "tok", "a", respond(401, "bad token"));
    expect(r).toEqual({ error: expect.stringContaining("FAS API 401") });
  });

  it("5xx is an error, not a denial", async () => {
    const r = await checkOwnership(API, "tok", "a", respond(503, "upstream down"));
    expect(r).toEqual({ error: expect.stringContaining("FAS API 503") });
    expect("owned" in r).toBe(false);
  });

  it("network failure is an error", async () => {
    const f = vi.fn(async () => { throw new TypeError("fetch failed"); }) as unknown as typeof fetch;
    expect(await checkOwnership(API, "tok", "a", f)).toEqual({ error: expect.stringContaining("unreachable") });
  });

  it("malformed 2xx body is an error", async () => {
    expect(await checkOwnership(API, "tok", "a", respond(200, "<html>"))).toHaveProperty("error");
    expect(await checkOwnership(API, "tok", "a", respond(200, { error: "x" }))).toHaveProperty("error");
  });
});
